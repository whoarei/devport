import { migrateBrowserStorage } from "./storageMigration";

async function start() {
  try {
    migrateBrowserStorage(localStorage);
  } catch (error) {
    console.error("Could not import application preferences", error);
    const { default: i18n } = await import("./i18n");
    const root = document.getElementById("root");
    if (root) { root.setAttribute("role", "alert"); root.textContent = i18n.t("migration.storageFailed"); }
    return;
  }
  // Preference modules initialize only after their legacy values are imported.
  await import("./renderApp");
}
void start();
