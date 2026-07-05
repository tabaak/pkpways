import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "PkpWays — Live Polish Railway Map",
  description:
    "A real-time interactive map showing trains moving across the Polish railway network.",
};

export const viewport: Viewport = {
  themeColor: "#0b1220",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

// Apply the persisted theme before first paint to avoid a flash. Defaults to
// light (per product decision) when nothing is stored.
const themeScript = `
(function () {
  try {
    var t = localStorage.getItem('pkpways-theme');
    if (t === 'dark') document.documentElement.classList.add('dark');
  } catch (e) {}
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      suppressHydrationWarning
    >
      <body>
        {/* beforeInteractive: injected before hydration via Next's own
            mechanism, avoiding the client/server tree diff (and any
            browser-extension-injected <head> nodes) that a raw inline
            <script> would be compared against. */}
        <Script id="theme-init" strategy="beforeInteractive">
          {themeScript}
        </Script>
        {children}
      </body>
    </html>
  );
}
