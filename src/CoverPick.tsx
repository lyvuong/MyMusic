import { useRef, useState } from "react";

const MAX_SIDE = 1000;

/** Scales a picked image down (the longer side to 1000 px) and returns it as base64 JPEG without the data: prefix. */
async function toJpeg(file: File): Promise<string> {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error("That file is not an image this browser can read.");
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Cannot process the image in this browser.");
  ctx.fillStyle = "#fff"; // transparent PNGs would turn black as JPEG
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const url = canvas.toDataURL("image/jpeg", 0.88);
  return url.slice(url.indexOf(",") + 1);
}

/** A button that lets the user pick an image file for an album's cover. */
export function CoverPick({ label, disabled, title, onPick }: {
  label: string;
  disabled?: boolean;
  title?: string;
  onPick: (jpegBase64: string) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button disabled={disabled || busy} title={title} onClick={() => input.current?.click()}>{busy ? "Saving cover…" : label}</button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          try {
            await onPick(await toJpeg(file));
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
          }
        }}
      />
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}
