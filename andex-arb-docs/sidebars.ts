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
    {
      type: 'category',
      label: 'Старт',
      collapsed: false,
      items: [
        {type: 'doc', id: 'start/s-chego-nachat', label: '1.1. С чего начать'},
        {type: 'doc', id: 'start/bazovye-pravila', label: '1.2. Базовые правила'},
      ],
    },
    {
      type: 'category',
      label: 'PM <> BK',
      collapsed: false,
      items: [
        {type: 'doc', id: 'pm-bk/interfeis', label: '2.1. Интерфейс'},
        {type: 'doc', id: 'pm-bk/kak-chitat-kartochku', label: '2.2. Как читать карточку'},
        {type: 'doc', id: 'pm-bk/filtry', label: '2.3. Фильтры'},
        {type: 'doc', id: 'pm-bk/kak-ispolzovat', label: '2.4. Как использовать'},
      ],
    },
    {
      type: 'category',
      label: 'PM <> PM',
      collapsed: false,
      items: [
        {type: 'doc', id: 'pm-pm/interfeis', label: '3.1. Интерфейс'},
        {type: 'doc', id: 'pm-pm/kak-chitat-kartochku', label: '3.2. Как читать карточку'},
        {type: 'doc', id: 'pm-pm/filtry', label: '3.3. Фильтры'},
        {type: 'doc', id: 'pm-pm/kak-ispolzovat', label: '3.4. Как использовать'},
      ],
    },
    {
      type: 'category',
      label: 'Площадки',
      collapsed: false,
      items: [
        {type: 'doc', id: 'ploshchadki/index', label: '4.1. Площадки'},
        {type: 'doc', id: 'ploshchadki/polymarket', label: 'Polymarket'},
        {type: 'doc', id: 'ploshchadki/dexsport', label: 'Dexsport'},
        {type: 'doc', id: 'ploshchadki/pinnacle', label: 'Pinnacle'},
        {type: 'doc', id: 'ploshchadki/stake', label: 'Stake'},
        {type: 'doc', id: 'ploshchadki/cloudbet', label: 'Cloudbet'},
      ],
    },
  ],
};

export default sidebars;
