import type { VendorPathsModule } from "../daemon-types.ts";

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "win32") {
    return [
      join(userHome, "AppData", "Roaming", "npm", "opencode.cmd"),
      join(userHome, ".opencode", "bin", "opencode.exe"),
      join(userHome, ".local", "bin", "opencode.exe"),
    ];
  }
  const userBins = [
    join(userHome, ".opencode", "bin", "opencode"),
    join(userHome, ".local", "bin", "opencode"),
    join(userHome, ".local", "share", "mise", "shims", "opencode"),
    join(userHome, ".npm-global", "bin", "opencode"),
  ];
  if (platform === "darwin") return [...userBins, "/opt/homebrew/bin/opencode", "/usr/local/bin/opencode"];
  return [...new Set([...linuxInstallDirs.map((dir) => join(dir, "opencode")), ...userBins])];
};

export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: ["OPENCODE_API_KEY", "OPENCODE_SERVER_PASSWORD"],
};

export const installCommand: VendorPathsModule["installCommand"] = "curl -fsSL https://opencode.ai/v2/install | bash";
// OpenCode does not support Windows package managers; npm selects the native binary in postinstall.
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] = "npm install -g @opencode/cli";

export const headlessLoginCommand: VendorPathsModule["headlessLoginCommand"] = "opencode auth login";
