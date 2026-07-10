import { nextRovingTabIndex } from "../client/roving-tabs";

const destinationCopy: Record<string, { label: string; html: string }> = {
  slack: {
    label: "SLACK",
    html: "<h3>Checkout retry fix is ready</h3><p>Duplicate subscriptions are now blocked by an idempotency key.</p><p><b>Verified:</b> 92 billing tests passed<br><b>Next:</b> one staging checkout</p>"
  },
  email: {
    label: "EMAIL",
    html: "<p><b>Subject: Checkout retry fix ready for staging</b></p><p>Hi team,</p><p>The duplicate-subscription issue is fixed. Retries now reuse an idempotency key, and all 92 billing tests pass.</p><p>The remaining step is one staging checkout before release.</p>"
  },
  github: {
    label: "GITHUB",
    html: "<h3>Summary</h3><ul><li>Reuse idempotency keys across checkout retries</li><li>Prevent duplicate subscription creation</li></ul><h3>Testing</h3><p>92 billing tests passed. Run one checkout in staging.</p>"
  },
  plain: {
    label: "PLAIN TEXT",
    html: "<p>Checkout retry fix is ready.</p><p>Duplicate subscriptions are now blocked by an idempotency key. All 92 billing tests passed. Next step: one staging checkout.</p>"
  }
};

function showToast(message: string): void {
  const toast = document.querySelector<HTMLElement>(".copy-toast");
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  window.setTimeout(() => { toast.hidden = true; }, 2_000);
}

async function copy(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
  showToast("Copied to clipboard");
}

document.querySelectorAll<HTMLElement>("[data-copy-command]").forEach((button) => {
  button.addEventListener("click", () => void copy(button.dataset.copyCommand ?? ""));
});

document.querySelectorAll<HTMLElement>("[data-demo-copy]").forEach((button) => {
  button.addEventListener("click", () => void copy(button.dataset.demoCopy ?? ""));
});

const destinationTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>("[data-destination]")
);

function selectDestination(button: HTMLButtonElement, moveFocus = false): void {
  const selected = destinationCopy[button.dataset.destination ?? "slack"];
  if (!selected) return;
  destinationTabs.forEach((candidate) => {
    const active = candidate === button;
    candidate.setAttribute("aria-selected", String(active));
    candidate.tabIndex = active ? 0 : -1;
  });
  const preview = document.querySelector<HTMLElement>("[data-destination-panel]");
  const label = document.querySelector<HTMLElement>("[data-preview-label]");
  const content = document.querySelector<HTMLElement>("[data-preview-content]");
  if (preview) preview.setAttribute("aria-labelledby", button.id);
  if (label) label.textContent = selected.label;
  if (content) content.innerHTML = selected.html;
  if (moveFocus) button.focus();
}

destinationTabs.forEach((button, index) => {
  button.addEventListener("click", () => selectDestination(button));
  button.addEventListener("keydown", (event) => {
    const nextIndex = nextRovingTabIndex(event.key, index, destinationTabs.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const next = destinationTabs[nextIndex];
    if (next) selectDestination(next, true);
  });
});

const year = document.querySelector<HTMLElement>("[data-year]");
if (year) year.textContent = String(new Date().getFullYear());
