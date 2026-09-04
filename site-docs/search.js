const SEARCH_BUTTON_SELECTOR = "#search-bar-entry, #search-bar-entry-mobile";
const SEARCH_BOUND_ATTRIBUTE = "data-maister-search-bound";
const PAGEFIND_STYLES_ID = "maister-pagefind-styles";
const PAGEFIND_SCRIPT_ID = "maister-pagefind-script";
const PAGEFIND_TRIGGER_ID = "maister-pagefind-trigger";
const PAGEFIND_MODAL_ID = "maister-pagefind-modal";

let pagefindUiPromise;

function currentLocale() {
  return window.location.pathname === "/ru" || window.location.pathname.startsWith("/ru/")
    ? "ru"
    : "en";
}

function searchLabels() {
  return currentLocale() === "ru"
    ? { language: "RU · EN", languageAction: "Сменить язык", search: "Поиск по документации" }
    : { language: "EN · RU", languageAction: "Change language", search: "Search documentation" };
}

function currentTheme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function syncPagefindTheme() {
  const modal = document.getElementById(PAGEFIND_MODAL_ID);
  if (modal) modal.setAttribute("data-pf-theme", currentTheme());
}

function ensurePagefindStyles() {
  if (document.getElementById(PAGEFIND_STYLES_ID)) return;

  const link = document.createElement("link");
  link.id = PAGEFIND_STYLES_ID;
  link.rel = "stylesheet";
  link.href = "/pagefind/pagefind-component-ui.css";
  document.head.append(link);
}

function ensurePagefindScript() {
  const existing = document.getElementById(PAGEFIND_SCRIPT_ID);
  if (existing) {
    return customElements.whenDefined("pagefind-modal-trigger");
  }

  const script = document.createElement("script");
  script.id = PAGEFIND_SCRIPT_ID;
  script.type = "module";
  script.src = "/pagefind/pagefind-component-ui.js";

  const loaded = new Promise((resolve, reject) => {
    script.addEventListener("load", resolve, { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("Unable to load the local Pagefind search bundle")),
      { once: true },
    );
  });

  document.head.append(script);
  return loaded.then(() => customElements.whenDefined("pagefind-modal-trigger"));
}

function ensurePagefindElements() {
  const existingTrigger = document.getElementById(PAGEFIND_TRIGGER_ID);
  const existingModal = document.getElementById(PAGEFIND_MODAL_ID);
  if (existingTrigger && existingModal) {
    syncPagefindTheme();
    return { modal: existingModal, trigger: existingTrigger };
  }

  const trigger = document.createElement("pagefind-modal-trigger");
  trigger.id = PAGEFIND_TRIGGER_ID;
  trigger.hidden = true;
  trigger.setAttribute("instance", "maister-docs");

  const modal = document.createElement("pagefind-modal");
  modal.id = PAGEFIND_MODAL_ID;
  modal.setAttribute("instance", "maister-docs");
  modal.setAttribute("reset-on-close", "");
  modal.setAttribute("data-pf-theme", currentTheme());

  document.body.append(trigger, modal);
  return { modal, trigger };
}

function loadPagefindUi() {
  if (pagefindUiPromise) return pagefindUiPromise;

  ensurePagefindStyles();
  pagefindUiPromise = ensurePagefindScript().then(ensurePagefindElements);
  return pagefindUiPromise;
}

function openPagefindModal(trigger) {
  const button = trigger.querySelector("button");
  if (!button) throw new Error("Local Pagefind search trigger did not render its button");

  button.click();
}

function openLocalSearch(event) {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();

  void loadPagefindUi()
    .then(({ trigger }) => openPagefindModal(trigger))
    .catch((error) => console.error("Local documentation search failed", { error }));
}

function bindSearchButtons() {
  document.querySelectorAll(SEARCH_BUTTON_SELECTOR).forEach((button) => {
    if (button.hasAttribute(SEARCH_BOUND_ATTRIBUTE)) return;

    button.setAttribute(SEARCH_BOUND_ATTRIBUTE, "true");
    button.setAttribute("aria-label", searchLabels().search);
    button.addEventListener("click", openLocalSearch, { capture: true });
    button.addEventListener("focus", () => void loadPagefindUi(), { once: true });
    button.addEventListener("pointerenter", () => void loadPagefindUi(), { once: true });
  });
}

function formatLanguageSwitch() {
  const button = document.getElementById("localization-select-trigger");
  const label = button?.querySelector("span");
  if (!button || !label) return;

  const labels = searchLabels();
  button.setAttribute("aria-label", labels.languageAction);
  if (label.textContent !== labels.language) label.textContent = labels.language;
}

function initializeDocsChrome() {
  bindSearchButtons();
  formatLanguageSwitch();

  const observer = new MutationObserver(() => {
    bindSearchButtons();
    formatLanguageSwitch();
    syncPagefindTheme();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  observer.observe(document.documentElement, { attributeFilter: ["class"] });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeDocsChrome, { once: true });
} else {
  initializeDocsChrome();
}
