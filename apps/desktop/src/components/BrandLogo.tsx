import { useEffect, useState } from "react";
// Renderer-sized copies of the brand marks. The 1024px masters in build/ are
// installer icons for electron-builder; BrandLogo never renders above 64px.
import brandLogoUrlLight from "../assets/brand/logo-light.png";
import brandLogoUrlDark from "../assets/brand/logo-dark.png";
import { useAppearanceMedia } from "../lib/appearance-media";

export function BrandLogo({ size = 16 }: { size?: number }) {
  const icon = useAppearanceMedia().icon;
  const [failedUrl, setFailedUrl] = useState<string>();
  const [dark, setDark] = useState(() => document.documentElement.dataset.theme !== "light");

  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(el.dataset.theme !== "light");
    });
    observer.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  return (
    <img
      className="brand-logo"
      src={icon && icon.url !== failedUrl ? icon.url : (dark ? brandLogoUrlDark : brandLogoUrlLight)}
      onError={() => { if (icon) setFailedUrl(icon.url); }}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
    />
  );
}
