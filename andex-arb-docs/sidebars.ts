import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  tutorialSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Basics',
      items: ['basics/what-is-zeroplay', 'basics/how-to-use'],
    },
    {
      type: 'category',
      label: 'Legal',
      items: ['legal/overview', 'legal/disclaimer', 'legal/terms', 'legal/privacy'],
    },
  ],
};

export default sidebars;
