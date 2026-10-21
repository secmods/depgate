/** Real CVSS vectors, as OSV publishes them in a vulnerability's `severity` list, with their base scores. */
export const V4_9_3 = 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N';
export const V4_4_8 = 'CVSS:4.0/AV:L/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N';
export const V31_9_8 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
export const V31_8_8 = 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H';
export const V31_7_5 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H';
export const V31_6_1 = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N';
export const V30_6_5 = 'CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N';

/** An OSV `severity` list holding one CVSS 3.x vector. */
export function cvss3(vector: string): Array<{ type: string; score: string }> {
  return [{ type: 'CVSS_V3', score: vector }];
}

/** OSV `severity` lists: HIGH is CVSS 3.1 8.8, MEDIUM is CVSS 3.1 6.1. */
export const HIGH_CVSS = cvss3(V31_8_8);
export const MEDIUM_CVSS = cvss3(V31_6_1);
