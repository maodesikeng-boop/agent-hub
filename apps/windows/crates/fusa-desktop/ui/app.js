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
  const errorRow = document.getElementById("error-row");
  const errorText = document.getElementById("error-text");
  const btnInstallWsl = document.getElementById("btn-install-wsl");
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
    btnInstallWsl.disabled = disabled;
    btnRetry.disabled = disabled;
    btnOpenTerminal.disabled = disabled;
    btnRefreshVendors.disabled = disabled;
    btnContinue.disabled = disabled;
  }

  function renderProviders(vendors) {
    providersList.replaceChildren();
    if (!Array.isArray(vendors) || vendors.length === 0) {
      const empty = document.createElement("div");
      empty.className = "provider-item";
      const text = document.createElement("p");
      text.className = "row-detail";
      text.textContent = "Open terminal to install and sign in to your preferred agent CLI";
      empty.appendChild(text);
      providersList.appendChild(empty);
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
      name.textContent = item.id || item.command;

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

      if (!item.installed && item.install_command) {
        const preInstall = document.createElement("pre");
        preInstall.className = "cmd-block";
        preInstall.textContent = item.install_command;
        cmds.appendChild(preInstall);
      }

      if (item.login_command) {
        const preLogin = document.createElement("pre");
        preLogin.className = "cmd-block";
        preLogin.textContent = item.login_command;
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
    stageTitle.textContent = view.title || "Preparing…";
    stageDetail.textContent = view.detail || "";

    if (view.error) {
      errorText.textContent = view.error;
      errorRow.hidden = false;
    } else {
      errorText.textContent = "";
      errorRow.hidden = true;
    }

    btnInstallWsl.hidden = !view.canInstallWsl;
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

  btnInstallWsl.addEventListener("click", () => {
    runUserAction(() => tauriInvoke("install_wsl_component"));
  });

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
