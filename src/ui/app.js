const state = {
  config: null,
  selectedId: null
};

const elements = {
  activeLabel: document.querySelector("#activeLabel"),
  providerList: document.querySelector("#providerList"),
  statusBox: document.querySelector("#statusBox"),
  saveBtn: document.querySelector("#saveBtn"),
  testBtn: document.querySelector("#testBtn"),
  addBtn: document.querySelector("#addBtn"),
  activeBtn: document.querySelector("#activeBtn"),
  copyBtn: document.querySelector("#copyBtn"),
  deleteBtn: document.querySelector("#deleteBtn"),
  fullPayloadLogging: document.querySelector("#fullPayloadLoggingInput"),
  fields: {
    id: document.querySelector("#idInput"),
    name: document.querySelector("#nameInput"),
    type: document.querySelector("#typeInput"),
    base_url: document.querySelector("#baseUrlInput"),
    model: document.querySelector("#modelInput"),
    api_key: document.querySelector("#apiKeyInput"),
    reasoning_enabled: document.querySelector("#reasoningEnabledInput"),
    reasoning_effort: document.querySelector("#reasoningEffortInput"),
    minimal_policy: document.querySelector("#minimalPolicyInput"),
    timeout_ms: document.querySelector("#timeoutInput"),
    request_max_retries: document.querySelector("#requestRetriesInput"),
    stream_max_retries: document.querySelector("#streamRetriesInput")
  }
};

async function loadConfig() {
  const response = await fetch("/api/config");
  state.config = await response.json();
  state.selectedId ||= state.config.active_provider;
  render();
}

function render() {
  const active = state.config.active_provider;
  elements.activeLabel.textContent = `Active provider: ${active}`;
  elements.fullPayloadLogging.value = String(state.config.logging?.full_payloads === true);
  elements.providerList.innerHTML = "";
  for (const provider of state.config.providers) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `provider-item${provider.id === state.selectedId ? " active" : ""}`;
    button.innerHTML = `<span class="provider-name"></span><span class="provider-badge"></span>`;
    button.querySelector(".provider-name").textContent = provider.name;
    button.querySelector(".provider-badge").textContent = provider.id === active ? "active" : provider.reasoning?.effort || "";
    button.addEventListener("click", () => {
      saveFormIntoSelected();
      state.selectedId = provider.id;
      render();
    });
    elements.providerList.append(button);
  }

  const selected = selectedProvider();
  if (!selected) {
    return;
  }
  elements.fields.id.value = selected.id;
  elements.fields.name.value = selected.name || "";
  elements.fields.type.value = selected.type || "deepseek";
  elements.fields.base_url.value = selected.base_url || "";
  elements.fields.model.value = selected.model || "";
  elements.fields.api_key.value = "";
  elements.fields.api_key.placeholder = selected.masked_api_key || "Leave blank to keep existing key";
  elements.fields.reasoning_enabled.value = String(selected.reasoning?.enabled !== false);
  elements.fields.reasoning_effort.value = selected.reasoning?.effort || "high";
  elements.fields.minimal_policy.value = selected.reasoning?.minimal_policy || "disabled";
  elements.fields.timeout_ms.value = selected.timeout_ms || 120000;
  elements.fields.request_max_retries.value = selected.request_max_retries ?? 2;
  elements.fields.stream_max_retries.value = selected.stream_max_retries ?? 0;
}

function selectedProvider() {
  return state.config.providers.find((provider) => provider.id === state.selectedId) || state.config.providers[0];
}

function saveFormIntoSelected() {
  state.config.logging = {
    ...(state.config.logging || {}),
    full_payloads: elements.fullPayloadLogging.value === "true"
  };

  const provider = selectedProvider();
  if (!provider) {
    return;
  }
  const oldId = provider.id;
  provider.id = elements.fields.id.value.trim();
  provider.name = elements.fields.name.value.trim() || provider.id;
  provider.type = elements.fields.type.value;
  provider.base_url = elements.fields.base_url.value.trim();
  provider.model = elements.fields.model.value.trim();
  provider.reasoning = {
    enabled: elements.fields.reasoning_enabled.value === "true",
    effort: elements.fields.reasoning_effort.value,
    minimal_policy: elements.fields.minimal_policy.value
  };
  provider.timeout_ms = Number(elements.fields.timeout_ms.value || 120000);
  provider.request_max_retries = Number(elements.fields.request_max_retries.value || 0);
  provider.stream_max_retries = Number(elements.fields.stream_max_retries.value || 0);
  const newKey = elements.fields.api_key.value.trim();
  if (newKey) {
    provider.api_key = newKey;
  }
  if (state.config.active_provider === oldId) {
    state.config.active_provider = provider.id;
  }
  state.selectedId = provider.id;
}

async function saveConfig() {
  saveFormIntoSelected();
  const response = await fetch("/api/config", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state.config)
  });
  const payload = await response.json();
  if (!response.ok) {
    setStatus(JSON.stringify(payload, null, 2));
    throw new Error(payload.error?.message || "Save failed");
  }
  state.config = payload;
  setStatus("Configuration saved");
  render();
}

async function setActive() {
  await saveConfig();
  const response = await fetch("/api/config/active-provider", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: state.selectedId })
  });
  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload.error?.message || "Set active failed");
  }
  await loadConfig();
  setStatus(`Active provider set to ${state.selectedId}`);
}

async function testProvider() {
  await saveConfig();
  setStatus("Testing provider...");
  const response = await fetch("/api/config/test-provider", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider_id: state.selectedId })
  });
  const payload = await response.json();
  setStatus(JSON.stringify(payload, null, 2));
}

function addProvider() {
  saveFormIntoSelected();
  const id = uniqueProviderId("provider");
  state.config.providers.push({
    id,
    name: "New Provider",
    type: "deepseek",
    enabled: true,
    base_url: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    api_key_ref: id,
    reasoning: { enabled: true, effort: "high", minimal_policy: "disabled" },
    timeout_ms: 120000,
    request_max_retries: 2,
    stream_max_retries: 0
  });
  state.selectedId = id;
  render();
}

function duplicateProvider() {
  saveFormIntoSelected();
  const selected = selectedProvider();
  const id = uniqueProviderId(`${selected.id}-copy`);
  state.config.providers.push({
    ...structuredClone(selected),
    id,
    name: `${selected.name} Copy`,
    api_key_ref: id,
    api_key: undefined,
    masked_api_key: undefined,
    has_api_key: false
  });
  state.selectedId = id;
  render();
}

function deleteProvider() {
  if (state.config.providers.length <= 1) {
    setStatus("At least one provider is required");
    return;
  }
  state.config.providers = state.config.providers.filter((provider) => provider.id !== state.selectedId);
  if (state.config.active_provider === state.selectedId) {
    state.config.active_provider = state.config.providers[0].id;
  }
  state.selectedId = state.config.active_provider;
  render();
}

function uniqueProviderId(prefix) {
  let candidate = prefix.replace(/[^A-Za-z0-9_-]/g, "-");
  let index = 2;
  const ids = new Set(state.config.providers.map((provider) => provider.id));
  while (ids.has(candidate)) {
    candidate = `${prefix}-${index}`;
    index += 1;
  }
  return candidate;
}

function setStatus(message) {
  elements.statusBox.textContent = message;
}

elements.saveBtn.addEventListener("click", () => saveConfig().catch(showError));
elements.testBtn.addEventListener("click", () => testProvider().catch(showError));
elements.activeBtn.addEventListener("click", () => setActive().catch(showError));
elements.addBtn.addEventListener("click", addProvider);
elements.copyBtn.addEventListener("click", duplicateProvider);
elements.deleteBtn.addEventListener("click", deleteProvider);

function showError(error) {
  setStatus(error.stack || error.message || String(error));
}

loadConfig().catch(showError);
