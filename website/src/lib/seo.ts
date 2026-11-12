import { DOWNLOADS, SITE } from '../config/site';

export function softwareLd(version: string | null) {
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: SITE.name,
    description: SITE.description,
    url: SITE.url,
    operatingSystem: 'Windows 11',
    applicationCategory: 'DeveloperApplication',
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
    license: SITE.licenseUrl,
    downloadUrl: DOWNLOADS.installer,
    image: `${SITE.url}/og.png`,
    ...(version ? { softwareVersion: version } : {}),
  };
}
