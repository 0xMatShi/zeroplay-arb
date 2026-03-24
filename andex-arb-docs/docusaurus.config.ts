import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'SubLine',
  tagline: 'Documentation',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://docs.subline.space',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'subline',
  projectName: 'subline-docs',

  onBrokenLinks: 'throw',

  customFields: {
    // URL основного сайта — куда редиректить незалогиненных
    mainSiteUrl: process.env.NODE_ENV === 'production' ? 'https://subline.space' : 'http://localhost:5173',
    // URL бэкенда — для верификации токена
    backendUrl: process.env.NODE_ENV === 'production' ? 'https://api.subline.space' : 'http://localhost:3000',
  },

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'ru',
    locales: ['ru', 'en'],
  },

  plugins: ['docusaurus-plugin-image-zoom'],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],
  themes: [
    [
      require.resolve('@easyops-cn/docusaurus-search-local'),
      {
        indexDocs: true,
        indexBlog: false,
        indexPages: false,
        docsRouteBasePath: 'docs',
        hashed: true,
        language: ['ru', 'en'],
        searchBarShortcut: true,
        searchBarShortcutHint: true,
        searchBarShortcutKeymap: 'mod+k',
        searchBarPosition: 'right',
        searchResultLimits: 12,
        searchResultContextMaxLength: 80,
        explicitSearchResultPath: true,
        highlightSearchTermsOnTargetPage: true,
        removeDefaultStemmer: false,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'SubLine',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'tutorialSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          type: 'search',
          position: 'right',
        },
        {
          type: 'custom-LanguageToggle',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Старт',
              to: '/docs/start/s-chego-nachat',
            },
            {
              label: 'PM <> BK',
              to: '/docs/pm-bk/interfeis',
            },
            {
              label: 'PM <> PM',
              to: '/docs/pm-pm/interfeis',
            },
            {
              label: 'Площадки',
              to: '/docs/ploshchadki/polymarket',
            },
          ],
        },
        {
          title: 'Product',
          items: [
            {
              label: 'Application',
              href: 'https://subline.space/',
            },
            {
              label: 'Docs',
              href: 'https://docs.subline.space/',
            },
          ],
        },
      ],
      copyright: `Copyright ${new Date().getFullYear()} SubLine`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
    zoom: {
      selector: '.markdown img',
      config: {
        margin: 80,
        scrollOffset: 0,
      },
      background: {
        light: 'rgba(255, 255, 255, 0.7)',
        dark: 'rgba(0, 0, 0, 0.7)',
      },
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
