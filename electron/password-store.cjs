/** Chromium does not reliably detect a Secret Service backend on Hyprland.
 * Select it before app-ready, without overriding an explicit user choice. */
function configurePasswordStore(app, platform, env) {
  if (platform !== "linux") return;
  const desktops = (env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP || env.DESKTOP_SESSION || "").toLowerCase().split(":");
  if (!desktops.includes("hyprland") || app.commandLine.hasSwitch("password-store")) return;
  app.commandLine.appendSwitch("password-store", "gnome-libsecret");
}

module.exports = { configurePasswordStore };