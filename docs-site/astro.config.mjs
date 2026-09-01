import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";

export default defineConfig({
  site: "https://willibrandon.github.io",
  base: "/fresh-test-observatory",
  trailingSlash: "always",
  integrations: [
    starlight({
      title: "Test Observatory",
      description: "Test explorer plugin for the Fresh editor.",
      customCss: ["./src/styles/docs.css"],
      credits: false,
      components: {
        MarkdownContent: "./src/components/MarkdownContent.astro",
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/willibrandon/fresh-test-observatory",
        },
      ],
      sidebar: [
        { slug: "", label: "Overview" },
        { slug: "getting-started" },
        { slug: "using-the-dock" },
        { slug: "commands-and-keys" },
        { slug: "settings" },
        { slug: "coverage" },
        { slug: "ecosystems" },
        { slug: "extending" },
      ],
    }),
    sitemap(),
  ],
});
