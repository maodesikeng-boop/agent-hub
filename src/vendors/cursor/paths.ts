import type { VendorPathsModule } from "../daemon-types.ts";

export const fallbackPaths: VendorPathsModule["fallbackPaths"] = ({ userHome, platform, linuxInstallDirs, join }) => {
  if (platform === "win32") {
    return [
      join(userHome, "AppData", "Local", "cursor-agent", "cursor-agent.exe"),
      join(userHome, "AppData", "Local", "cursor-agent", "cursor-agent.cmd"),
      join(userHome, "AppData", "Local", "cursor-agent", "agent.exe"),
      join(userHome, "AppData", "Local", "cursor-agent", "agent.cmd"),
      join(userHome, ".local", "bin", "cursor-agent.exe"),
      join(userHome, ".local", "bin", "agent.exe"),
      join(userHome, "AppData", "Roaming", "npm", "cursor-agent.cmd"),
      join(userHome, "AppData", "Roaming", "npm", "agent.cmd"),
    ];
  }
  const localBin = join(userHome, ".local", "bin", "cursor-agent");
  if (platform === "darwin") return [localBin];
  return [...new Set([localBin, ...linuxInstallDirs.map((dir) => join(dir, "cursor-agent"))])];
};

export const credentialEnv: VendorPathsModule["credentialEnv"] = {
  names: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_ACCESS_TOKEN"],
};

export const installCommand = "curl https://cursor.com/install -fsS | bash";
export const windowsInstallCommand: VendorPathsModule["windowsInstallCommand"] =
  "irm 'https://cursor.com/install?win32=true' | iex";

export const headlessLoginCommand = "NO_OPEN_BROWSER=1 cursor-agent login";
