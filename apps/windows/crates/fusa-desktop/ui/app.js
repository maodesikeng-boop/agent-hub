(() => {
  "use strict";

  function tauriInvoke(cmd, args) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.invoke !== "function") {
      return Promise.reject(new Error("Tauri runtime unavailable"));
    }
    return internals.invoke(cmd, args || {});
  }

  function listenBootstrapEvent(eventName, onPayload) {
    const internals = window.__TAURI_INTERNALS__;
    if (!internals || typeof internals.transformCallback !== "function") {
      return Promise.resolve();
    }
    const handlerId = internals.transformCallback((event) => {
      if (event && event.payload) {
        onPayload(event.payload);
      }
    });
    return tauriInvoke("plugin:event|listen", {
      event: eventName,
      target: { kind: "Any" },
      handler: handlerId,
    });
  }

  const statusDot = document.getElementById("status-dot");
  const stageTitle = document.getElementById("stage-title");
  const stageDetail = document.getElementById("stage-detail");
  const gitRow = document.getElementById("git-row");
  const gitCmd = document.getElementById("git-cmd");
  const errorRow = document.getElementById("error-row");
  const errorText = document.getElementById("error-text");
  const btnRetry = document.getElementById("btn-retry");
  const btnOpenLogs = document.getElementById("btn-open-logs");
  const providersSection = document.getElementById("providers-section");
  const providersList = document.getElementById("providers-list");
  const btnOpenTerminal = document.getElementById("btn-open-terminal");
  const btnRefreshVendors = document.getElementById("btn-refresh-vendors");
  const btnContinue = document.getElementById("btn-continue");

  let busyAction = false;

  function setButtonsDisabled(disabled) {
    busyAction = disabled;
    btnRetry.disabled = disabled;
    btnOpenTerminal.disabled = disabled;
    btnRefreshVendors.disabled = disabled;
    btnContinue.disabled = disabled;
  }

  function renderProviders(vendors) {
    providersList.replaceChildren();
    if (!Array.isArray(vendors) || vendors.length === 0) {
      return;
    }

    for (const item of vendors) {
      const row = document.createElement("div");
      row.className = "provider-item";
      row.setAttribute("role", "listitem");

      const top = document.createElement("div");
      top.className = "provider-top";

      const left = document.createElement("div");
      left.className = "status-line";

      const dot = document.createElement("span");
      dot.className = "status-dot";
      dot.dataset.tone = item.installed ? "ready" : "muted";
      dot.setAttribute("aria-hidden", "true");

      const name = document.createElement("span");
      name.className = "row-title";
      name.textContent = item.label || item.id || item.command;

      left.appendChild(dot);
      left.appendChild(name);

      const stateLabel = document.createElement("span");
      stateLabel.className = "provider-state";
      stateLabel.textContent = item.installed ? "Installed" : "Not installed";

      top.appendChild(left);
      top.appendChild(stateLabel);
      row.appendChild(top);

      const cmds = document.createElement("div");
      cmds.className = "cmd-list";

      const installCmd = item.installCommand || item.install_command || "";
      const loginCmd = item.loginCommand || item.login_command || "";

      if (!item.installed && installCmd) {
        const preInstall = document.createElement("pre");
        preInstall.className = "cmd-block";
        preInstall.textContent = installCmd;
        cmds.appendChild(preInstall);
      }

      if (loginCmd) {
        const preLogin = document.createElement("pre");
        preLogin.className = "cmd-block";
        preLogin.textContent = loginCmd;
        cmds.appendChild(preLogin);
      }

      if (cmds.childElementCount > 0) {
        row.appendChild(cmds);
      }
      providersList.appendChild(row);
    }
  }

  function applyState(view) {
    if (!view) return;

    statusDot.dataset.tone = view.tone || "working";
    stageTitle.textContent = view.title || "Starting Fusa…";
    const detail = view.detail || "";
    stageDetail.textContent = detail;
    stageDetail.hidden = !detail;

    if (view.showGitGuide && view.gitInstallCommand) {
      gitCmd.textContent = view.gitInstallCommand;
      gitRow.hidden = false;
    } else {
      gitCmd.textContent = "";
      gitRow.hidden = true;
    }

    if (view.error) {
      errorText.textContent = view.error;
      errorRow.hidden = false;
    } else {
      errorText.textContent = "";
      errorRow.hidden = true;
    }

    btnRetry.hidden = !view.canRetry;
    btnOpenLogs.hidden = !view.canOpenLogs;

    if (view.showVendorGuide) {
      renderProviders(view.vendors || []);
      providersSection.hidden = false;
      btnContinue.disabled = busyAction || !view.canEnterWorkspace;
    } else {
      providersSection.hidden = true;
    }
  }

  async function runUserAction(fn) {
    if (busyAction) return;
    setButtonsDisabled(true);
    try {
      const next = await fn();
      if (next) applyState(next);
    } catch (err) {
      errorText.textContent = String(err && err.message ? err.message : err);
      errorRow.hidden = false;
    } finally {
      setButtonsDisabled(false);
    }
  }

  btnRetry.addEventListener("click", () => {
    runUserAction(() => tauriInvoke("retry_bootstrap"));
  });

  btnRefreshVendors.addEventListener("click", () => {
    runUserAction(() => tauriInvoke("retry_bootstrap"));
  });

  btnOpenLogs.addEventListener("click", () => {
    tauriInvoke("open_logs").catch(() => {});
  });

  btnOpenTerminal.addEventListener("click", () => {
    tauriInvoke("open_vendor_terminal").catch((err) => {
      errorText.textContent = String(err && err.message ? err.message : err);
      errorRow.hidden = false;
    });
  });

  btnContinue.addEventListener("click", () => {
    runUserAction(() => tauriInvoke("enter_workspace"));
  });

  listenBootstrapEvent("fusa://bootstrap-state", applyState).catch(() => {});
  tauriInvoke("get_bootstrap_state")
    .then(applyState)
    .catch((err) => {
      statusDot.dataset.tone = "error";
      stageTitle.textContent = "Unable to load status";
      errorText.textContent = String(err && err.message ? err.message : err);
      errorRow.hidden = false;
    });
})();
