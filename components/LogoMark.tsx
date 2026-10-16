import Image from "next/image";

/**
 * The Signex mark — the same pen-and-signature artwork as the installed app
 * icon (public/icon-512.png), cropped tight to public/logo-mark.png so it
 * reads at header sizes. Transparent, so it sits on light and dark headers.
 */
export default function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <Image
      src="/logo-mark.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0"
      priority
    />
  );
}
