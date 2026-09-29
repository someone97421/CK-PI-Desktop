import { useState } from "react";
import { useAppStore } from "../stores/app-store";
import { useAppearanceMedia } from "../lib/appearance-media";
import mascotUrl from "../assets/brand/home-mascot.webp";

export function HomeMascotLogo() {
  const asset = useAppearanceMedia().home;
  const [failedUrl, setFailedUrl] = useState<string>();
  const home = asset?.url === failedUrl ? null : asset;
  const size = useAppStore((state) => state.settings?.homeMediaSize ?? 256);
  return (
    <span
      className="home-mascot-logo"
      data-testid="home-mascot-logo"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {home?.mimeType.startsWith("video/") ? (
        <video key={home.url} className="home-mascot-media" src={home.url} width={size} height={size}
          autoPlay muted loop playsInline disablePictureInPicture onError={() => setFailedUrl(home.url)} />
      ) : (
        <img className={home ? "home-mascot-media" : "home-mascot-dinosaur"}
          src={home?.url ?? mascotUrl} alt="" width={size} height={size} draggable={false}
          onError={() => { if (home) setFailedUrl(home.url); }} />
      )}
    </span>
  );
}
