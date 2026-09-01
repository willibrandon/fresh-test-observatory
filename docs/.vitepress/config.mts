import { defineConfig } from "vitepress";

export default defineConfig({
  title: "Test Observatory",
  description: "Test discovery, focused runs, failure navigation, and coverage inside Fresh.",
  base: "/fresh-test-observatory/",
  srcDir: ".",
  outDir: "../dist/docs",
  cleanUrls: true,
  lastUpdated: true,
  appearance: "force-dark",
  head: [["link", { rel: "icon", href: "/fresh-test-observatory/logo.svg" }]],
  themeConfig: {
    logo: "/logo.svg",
    nav: [
      { text: "Guide", link: "/guide" },
      { text: "Adapter API", link: "/api" },
    ],
    sidebar: [
      {
        text: "Test Observatory",
        items: [
          { text: "Overview", link: "/" },
          { text: "Guide", link: "/guide" },
          { text: "Adapter API", link: "/api" },
        ],
      },
    ],
    outline: { level: "deep" },
    search: { provider: "local" },
    socialLinks: [
      { icon: "github", link: "https://github.com/willibrandon/fresh-test-observatory" },
    ],
    editLink: {
      pattern: "https://github.com/willibrandon/fresh-test-observatory/edit/main/docs/:path",
    },
    footer: {
      message: "A plugin for Fresh",
      copyright: "MIT License",
    },
  },
});
