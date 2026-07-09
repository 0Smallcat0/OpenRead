import {
  loadSettings,
  saveSettings,
  TARGET_LANGUAGES,
  DEFAULT_SETTINGS,
  type Settings,
} from '../../settings';

const form = document.querySelector<HTMLFormElement>('#settingsForm');
const baseUrlInput = document.querySelector<HTMLInputElement>('#baseUrl');
const modelInput = document.querySelector<HTMLInputElement>('#modelId');
const langSelect = document.querySelector<HTMLSelectElement>('#targetLang');
const vaultInput = document.querySelector<HTMLInputElement>('#obsidianVault');
const folderInput = document.querySelector<HTMLInputElement>('#obsidianFolder');
const enrichInput =
  document.querySelector<HTMLInputElement>('#enrichOnCapture');
const status = document.querySelector<HTMLDivElement>('#status');

if (
  form &&
  baseUrlInput &&
  modelInput &&
  langSelect &&
  vaultInput &&
  folderInput &&
  enrichInput &&
  status
) {
  for (const lang of TARGET_LANGUAGES) {
    const option = document.createElement('option');
    option.value = lang;
    option.textContent = lang;
    langSelect.appendChild(option);
  }

  void loadSettings().then((settings) => {
    baseUrlInput.value = settings.baseUrl;
    modelInput.value = settings.modelId;
    langSelect.value = settings.targetLang;
    vaultInput.value = settings.obsidianVault;
    folderInput.value = settings.obsidianFolder;
    enrichInput.checked = settings.enrichOnCapture;
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const settings: Settings = {
      baseUrl: baseUrlInput.value.trim() || DEFAULT_SETTINGS.baseUrl,
      modelId: modelInput.value.trim() || DEFAULT_SETTINGS.modelId,
      targetLang: langSelect.value,
      obsidianVault: vaultInput.value.trim(),
      obsidianFolder:
        folderInput.value.trim() || DEFAULT_SETTINGS.obsidianFolder,
      enrichOnCapture: enrichInput.checked,
    };
    void saveSettings(settings).then(() => {
      status.textContent = 'Saved ✓';
      window.setTimeout(() => {
        status.textContent = '';
      }, 1500);
    });
  });
}
