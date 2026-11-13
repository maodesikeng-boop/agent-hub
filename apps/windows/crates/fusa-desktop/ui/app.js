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
  const btnRetry = document.getElementById("btn-retry");
  const btnOpenLogs = document.getElementById("btn-open-logs");

  let busyAction = false;

  function setButtonsDisabled(disabled) {
    busyAction = disabled;
    btnRetry.disabled = disabled;
  }

  function applyState(view) {
    if (!view) return;

    statusDot.dataset.tone = view.tone || "working";
    stageTitle.textContent = view.title || "Starting Fusa…";
    const detail = view.detail || "";
    stageDetail.textContent = detail;
    stageDetail.hidden = !detail;

    if (view.error) {
      errorText.textContent = view.error;
      errorRow.hidden = false;
    } else {
      errorText.textContent = "";
      errorRow.hidden = true;
    }

    btnRetry.hidden = !view.canRetry;
    btnOpenLogs.hidden = !view.canOpenLogs;
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

  btnOpenLogs.addEventListener("click", () => {
    tauriInvoke("open_logs").catch(() => {});
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
