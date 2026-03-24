import React from 'react';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import {useAlternatePageUtils} from '@docusaurus/theme-common/internal';
import Link from '@docusaurus/Link';

export default function CustomLanguageToggle(): JSX.Element {
  const {
    i18n: {currentLocale},
  } = useDocusaurusContext();

  const alternatePageUtils = useAlternatePageUtils();
  const targetLocale = currentLocale === 'ru' ? 'en' : 'ru';
  const targetHref = alternatePageUtils.createUrl({locale: targetLocale, fullyQualified: false});
  const label = currentLocale === 'ru' ? 'EN' : 'RU';

  return (
    <Link href={targetHref} className="lang-switcher-docs">
      {label}
    </Link>
  );
}
