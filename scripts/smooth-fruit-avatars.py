#!/usr/bin/env python3
"""
平滑水果头像外轮廓（修复小红书白底源图多边形套索折线与浅粉/发白残边）：
  uv run --with pillow --with numpy --with scipy python3 scripts/smooth-fruit-avatars.py

背景：
- 8 组水果头像中，柑橘类 4 组（grapefruit / orange / lime / lemon）与 pomelo、bell_pepper 外圈均为平滑轮廓；
- kiwi 与 strawberry 的小红书白底源图本身由原作者用多边形套索裁切（外圈由约 16 段折线拼成，且草莓外圈带一圈浅粉白阴影晕边、猕猴桃右下带浅褐白残边），
  导致抠图生成的 `kiwi.webp`、`kiwi_wedge.webp`、`strawberry.webp`、`strawberry_wedge.webp` 边缘呈折线段。

做法：
1. 若本机存在原始高清白底截图（`~/.agent-hub/uploads/...`），直接从原图提取 1024×1024 底图；否则从仓库现有 256×256 切片超采样到 1024×1024 处理。
2. 在极坐标 (r, theta) 下提取外轮廓 r_alpha50(theta)，用低阶傅里叶级数（M=2，仅保留基频与椭圆谐波）拟合光滑外轮廓并向内微缩避开折线弦中点。
3. 在外圈过渡带内沿径向由内部干净果肉色向外平滑延展，彻底消除浅粉白/发白套索残边。
4. 在 1024×1024 下按 2px smoothstep 距离场生成抗锯齿 alpha 通道，LANCZOS 缩放到 256×256 导出整片 `.webp`，并按果络角度切出对应的 `*_wedge.webp`。
"""

from __future__ import annotations

import os
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.ndimage import distance_transform_edt, gaussian_filter1d

ROOT = Path(__file__).resolve().parent.parent
AVATARS_DIR = ROOT / "src" / "web" / "assets" / "avatars"
UPLOADS_DIR = Path.home() / ".agent-hub" / "uploads"

TARGETS = [
    {
        "repo_name": "kiwi",
        "kind": "kiwi",
        "upload_rel": "a97db29251925d17/8dd4af724fbcd7ea04e2a2dfbf60b5b5.jpg",
        "lower_pts": [(85, 11.0), (175, 11.0), (275, 11.0)],
        "upper_pts": [(85, 72.0), (175, 72.0), (275, 72.0)],
    },
    {
        "repo_name": "strawberry",
        "kind": "strawberry",
        "upload_rel": "2c69fa971caffe00/0032503bb3ea4755695b623e3e74f62d.jpg",
        "lower_pts": [(85, 14.0), (175, 14.0), (275, 14.0)],
        "upper_pts": [(85, 78.0), (175, 78.0), (275, 78.0)],
    },
]


def extract_raw_1024_from_upload(path: Path) -> Image.Image:
    im = Image.open(path).convert("RGB")
    w, h = im.size
    arr = np.asarray(im, dtype=np.float32)
    y0, y1 = int(h * 0.16), int(h * 0.55)
    x0, x1 = int(w * 0.06), int(w * 0.94)
    crop = arr[y0:y1, x0:x1]

    max_c = crop.max(axis=2)
    min_c = crop.min(axis=2)
    chroma = max_c - min_c
    dist_white = np.sqrt(((255.0 - crop) ** 2).sum(axis=2))
    is_pure_white = (dist_white < 10.0) & (chroma < 8.0)
    labeled, _ = ndimage.label(is_pure_white)
    border_labels = set(
        np.unique(np.concatenate([labeled[0, :], labeled[-1, :], labeled[:, 0], labeled[:, -1]]))
    )
    border_labels.discard(0)
    bg_mask = np.isin(labeled, list(border_labels))

    fg_core = ~bg_mask
    fg_labeled, fg_num = ndimage.label(fg_core)
    if fg_num > 1:
        sizes = ndimage.sum(fg_core, fg_labeled, range(1, fg_num + 1))
        fg_core = fg_labeled == (int(np.argmax(sizes)) + 1)
        fg_core = ndimage.binary_fill_holes(fg_core)

    dist_in = ndimage.distance_transform_edt(fg_core)
    natural_alpha = np.clip((dist_white - 3.0) / 28.0 + chroma / 22.0, 0.0, 1.0)
    alpha = np.where(dist_in > 4.5, 1.0, np.where(~fg_core, 0.0, natural_alpha))

    rgb = crop.copy()
    semi = (alpha > 0.03) & (alpha < 0.97)
    for c in range(3):
        unmixed = (rgb[:, :, c] - (1.0 - alpha) * 255.0) / np.maximum(alpha, 0.25)
        rgb[:, :, c] = np.where(semi, np.clip(unmixed, 0.0, 255.0), rgb[:, :, c])

    ys, xs = np.where(alpha > 0.02)
    by0, by1 = ys.min(), ys.max() + 1
    bx0, bx1 = xs.min(), xs.max() + 1
    rgba_crop = np.dstack([rgb[by0:by1, bx0:bx1], alpha[by0:by1, bx0:bx1] * 255.0]).astype(np.uint8)
    fruit_im = Image.fromarray(rgba_crop, mode="RGBA")
    fw, fh = fruit_im.size
    scale = int(round(1024 * 0.88)) / max(fw, fh)
    nw, nh = int(round(fw * scale)), int(round(fh * scale))
    fruit_resized = fruit_im.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    canvas.paste(fruit_resized, ((1024 - nw) // 2, (1024 - nh) // 2), fruit_resized)
    return canvas


def smooth_fruit_1024(im_1024: Image.Image, kind: str) -> Image.Image:
    arr = np.asarray(im_1024.convert("RGBA"), dtype=np.float32)
    rgb = arr[..., :3].copy()
    orig_alpha = arr[..., 3] / 255.0

    ys, xs = np.where(orig_alpha > 0.5)
    cy, cx = float(ys.mean()), float(xs.mean())

    N = 720
    thetas = np.linspace(-np.pi, np.pi, N, endpoint=False)
    r_alpha50 = np.zeros(N, dtype=np.float32)
    r_flesh = np.zeros(N, dtype=np.float32)

    rs = np.linspace(360.0, 465.0, 421, dtype=np.float32)
    for i, th in enumerate(thetas):
        c, s = np.cos(th), np.sin(th)
        px = np.clip(np.round(cx + rs * c).astype(int), 0, 1023)
        py = np.clip(np.round(cy + rs * s).astype(int), 0, 1023)
        av = orig_alpha[py, px]
        R, G, B = rgb[py, px, 0], rgb[py, px, 1], rgb[py, px, 2]

        idx_a = np.where(av >= 0.5)[0]
        r_a = float(rs[idx_a[-1]]) if len(idx_a) else 442.0
        r_alpha50[i] = r_a

        if kind == "kiwi":
            bad = (av <= 0.85) | ((G - B) < 50.0) | (B > 150.0) | (np.maximum(R, G) > 224.0)
            idx_good = np.where(~bad)[0]
            r_f = float(rs[idx_good[-1]]) if len(idx_good) else (r_a - 10.0)
            r_flesh[i] = min(r_f, r_a - 5.0)
        else:
            in_rim = rs >= 422.0
            halo = in_rim & ((av <= 0.85) | (B > 92.0) | (G > 112.0) | ((R - G) < 85.0))
            bad_idx = np.where(halo)[0]
            if len(bad_idx):
                r_f = float(rs[bad_idx[0]]) - 1.0
            else:
                r_f = r_a - 5.0
            r_flesh[i] = np.clip(r_f, 418.0, r_a - 5.0)

    r_flesh_smooth = gaussian_filter1d(r_flesh, sigma=8.0, mode="wrap")

    # 低阶傅里叶拟合（M=2）：保留整体圆/椭圆比例，滤除高阶多边形折线谐波
    fft_coeffs = np.fft.rfft(r_alpha50)
    fft_filtered = np.zeros_like(fft_coeffs)
    fft_filtered[:3] = fft_coeffs[:3]
    r_fit = np.fft.irfft(fft_filtered, n=N)

    inset = 6.5 if kind == "kiwi" else 8.0
    r_target = r_fit - inset

    yy, xx = np.mgrid[0:1024, 0:1024]
    dx = xx - cx
    dy = yy - cy
    r_grid = np.hypot(dx, dy)
    th_grid = np.arctan2(dy, dx)

    th_wrapped = np.concatenate([thetas - 2 * np.pi, thetas, thetas + 2 * np.pi])
    r_target_2d = np.interp(th_grid, th_wrapped, np.tile(r_target, 3))
    r_flesh_2d = np.interp(th_grid, th_wrapped, np.tile(r_flesh_smooth, 3))

    rim_start = np.minimum(r_flesh_2d - 6.0, r_target_2d - 10.0)
    rim_mask = (r_grid > rim_start) & (r_grid < (r_target_2d + 12.0))
    cos_t = np.cos(th_grid)
    sin_t = np.sin(th_grid)

    r_s1 = rim_start - 2.0
    r_s2 = rim_start - 6.0
    r_s3 = rim_start - 10.0
    sx1 = np.clip(np.round(cx + r_s1 * cos_t).astype(int), 0, 1023)
    sy1 = np.clip(np.round(cy + r_s1 * sin_t).astype(int), 0, 1023)
    sx2 = np.clip(np.round(cx + r_s2 * cos_t).astype(int), 0, 1023)
    sy2 = np.clip(np.round(cy + r_s2 * sin_t).astype(int), 0, 1023)
    sx3 = np.clip(np.round(cx + r_s3 * cos_t).astype(int), 0, 1023)
    sy3 = np.clip(np.round(cy + r_s3 * sin_t).astype(int), 0, 1023)
    sampled_rgb = 0.45 * rgb[sy1, sx1] + 0.35 * rgb[sy2, sx2] + 0.20 * rgb[sy3, sx3]

    w_blend = np.clip((r_grid - rim_start) / 8.0, 0.0, 1.0)
    w_blend = w_blend * w_blend * (3.0 - 2.0 * w_blend)
    if kind == "kiwi":
        is_washed = (r_grid > 415.0) & (((rgb[..., 1] - rgb[..., 2]) < 45.0) | (rgb[..., 2] > 152.0))
    else:
        is_washed = (r_grid > 418.0) & ((rgb[..., 2] > 90.0) | (rgb[..., 1] > 110.0))
    w_eff = np.where(is_washed, np.maximum(w_blend, 0.92), w_blend)

    rgb_out = np.where(
        rim_mask[..., None], rgb * (1.0 - w_eff[..., None]) + sampled_rgb * w_eff[..., None], rgb
    )

    sdf = r_target_2d - r_grid
    alpha_new = np.clip((sdf + 1.0) / 2.0, 0.0, 1.0)
    alpha_new = alpha_new * alpha_new * (3.0 - 2.0 * alpha_new)

    rgb_out = np.where((sdf > -6.0)[..., None], rgb_out, 0.0)
    out = np.dstack([np.clip(rgb_out, 0, 255), np.clip(alpha_new * 255.0, 0, 255)]).astype(np.uint8)
    im_clean = Image.fromarray(out, mode="RGBA")

    ys2, xs2 = np.where(alpha_new > 0.02)
    by0, by1 = ys2.min(), ys2.max() + 1
    bx0, bx1 = xs2.min(), xs2.max() + 1
    fruit_crop = im_clean.crop((bx0, by0, bx1, by1))
    fw, fh = fruit_crop.size
    target_max = int(round(1024 * 0.88))
    scale = target_max / max(fw, fh)
    nw, nh = int(round(fw * scale)), int(round(fh * scale))
    fruit_resized = fruit_crop.resize((nw, nh), Image.Resampling.LANCZOS)
    canvas_1024 = Image.new("RGBA", (1024, 1024), (0, 0, 0, 0))
    canvas_1024.paste(fruit_resized, ((1024 - nw) // 2, (1024 - nh) // 2), fruit_resized)
    return canvas_1024


def interp_smooth_angle(pts: list[tuple[float, float]], r_grid_1024: np.ndarray) -> np.ndarray:
    rs = np.array([p[0] for p in pts], dtype=np.float32)
    angs = np.array([p[1] for p in pts], dtype=np.float32)
    raw = np.interp(r_grid_1024, rs, angs)
    return gaussian_filter1d(raw, sigma=25.0)


def make_wedge_from_512(
    im_512: Image.Image,
    lower_pts: list[tuple[float, float]],
    upper_pts: list[tuple[float, float]],
) -> Image.Image:
    arr = np.asarray(im_512.convert("RGBA"), dtype=np.float32)
    orig_alpha = arr[..., 3] / 255.0

    yy, xx = np.mgrid[0:512, 0:512]
    cx, cy = 256.0, 256.0
    dy = -(yy - cy)
    dx = xx - cx
    r = np.hypot(dx, dy)
    theta = np.degrees(np.arctan2(dy, dx))

    r_grid_1024 = np.arange(400, dtype=np.float32) * 2.0
    c1 = interp_smooth_angle(lower_pts, r_grid_1024)
    c2 = interp_smooth_angle(upper_pts, r_grid_1024)

    r_idx = np.clip(r.astype(np.int32), 0, 399)
    theta1_r = c1[r_idx]
    theta2_r = c2[r_idx]

    d_ang1 = ((theta - theta1_r + 180) % 360) - 180
    d_ang2 = ((theta2_r - theta + 180) % 360) - 180
    dist_edge1 = np.radians(d_ang1) * np.maximum(r, 12.0)
    dist_edge2 = np.radians(d_ang2) * np.maximum(r, 12.0)

    dist_inside_fruit = distance_transform_edt(orig_alpha > 0.15) - distance_transform_edt(
        orig_alpha <= 0.15
    )
    r_tip = 7.0
    dist_tip = r - r_tip

    k_tip = 8.0
    a1 = np.maximum(k_tip - dist_edge1, 0.0) / k_tip
    a2 = np.maximum(k_tip - dist_edge2, 0.0) / k_tip
    at = np.maximum(k_tip - dist_tip, 0.0) / k_tip
    sdf_inner = np.minimum(np.minimum(dist_edge1, dist_edge2), dist_tip) - k_tip * np.maximum(
        np.hypot(np.maximum(a1, at), a2) - 1.0, 0.0
    )

    k_shoulder = 9.0
    s_in = np.maximum(k_shoulder - sdf_inner, 0.0) / k_shoulder
    s_out = np.maximum(k_shoulder - dist_inside_fruit, 0.0) / k_shoulder
    sdf_cut = sdf_inner - k_shoulder * np.maximum(np.hypot(s_in, s_out) - 1.0, 0.0)

    cut_mask = np.clip((sdf_cut + 0.6) / 1.8, 0.0, 1.0)
    cut_mask = cut_mask * cut_mask * (3.0 - 2.0 * cut_mask)

    final_alpha = orig_alpha * cut_mask
    out_arr = arr.copy()
    out_arr[..., 3] = final_alpha * 255.0

    wy, wx = np.where(final_alpha > 0.03)
    y0, y1 = wy.min(), wy.max()
    x0, x1 = wx.min(), wx.max()
    crop = Image.fromarray(out_arr[y0 : y1 + 1, x0 : x1 + 1].astype(np.uint8), "RGBA")

    cw, ch = crop.size
    scale = (512 * 0.80) / max(cw, ch)
    nw, nh = int(round(cw * scale)), int(round(ch * scale))
    resized = crop.resize((nw, nh), Image.Resampling.LANCZOS)

    canvas = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    canvas.paste(resized, ((512 - nw) // 2, (512 - nh) // 2), resized)
    return canvas.resize((256, 256), Image.Resampling.LANCZOS)


def main() -> None:
    for item in TARGETS:
        repo_name = item["repo_name"]
        kind = item["kind"]
        upload_path = UPLOADS_DIR / item["upload_rel"]
        slice_path = AVATARS_DIR / f"{repo_name}.webp"
        wedge_path = AVATARS_DIR / f"{repo_name}_wedge.webp"

        if upload_path.exists():
            raw_1024 = extract_raw_1024_from_upload(upload_path)
            src_desc = f"upload:{upload_path.name}"
        else:
            raw_1024 = Image.open(slice_path).convert("RGBA").resize(
                (1024, 1024), Image.Resampling.LANCZOS
            )
            src_desc = f"avatar:{slice_path.name}"

        sm_1024 = smooth_fruit_1024(raw_1024, kind)
        sm_512 = sm_1024.resize((512, 512), Image.Resampling.LANCZOS)
        sm_256 = sm_1024.resize((256, 256), Image.Resampling.LANCZOS)
        wedge_256 = make_wedge_from_512(sm_512, item["lower_pts"], item["upper_pts"])

        sm_256.save(slice_path, "WEBP", quality=92, alpha_quality=100)
        wedge_256.save(wedge_path, "WEBP", quality=92, method=6)
        print(
            f"{repo_name} ({src_desc}): {slice_path.name}={os.path.getsize(slice_path)}B, "
            f"{wedge_path.name}={os.path.getsize(wedge_path)}B"
        )


if __name__ == "__main__":
    main()
