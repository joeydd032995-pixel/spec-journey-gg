/** Trigger a browser download of `text` as a CSV file named `filename`. */
export function downloadCsv(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** Read a File input's first file as text and pass it to `onText`. */
export function readFileAsText(file: File | undefined, onText: (text: string) => void): void {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => onText(String(reader.result));
  reader.readAsText(file);
}
