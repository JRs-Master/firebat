/**
 * Timezone 옵션 — 위자드 + 어드민 설정 공통 source.
 *
 * lang === 'ko' → labelKo 표시, 그 외 → label (영어).
 * IANA timezone identifier 는 value 에 그대로. UTC offset 순서대로 박힘.
 */

export interface TimezoneOption {
  value: string;
  label: string;
  labelKo: string;
}

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { value: 'Pacific/Midway',        label: '(UTC-11:00) Midway',           labelKo: '(UTC-11:00) 미드웨이' },
  { value: 'Pacific/Honolulu',      label: '(UTC-10:00) Hawaii',           labelKo: '(UTC-10:00) 하와이' },
  { value: 'America/Anchorage',     label: '(UTC-09:00) Alaska',           labelKo: '(UTC-09:00) 알래스카' },
  { value: 'America/Los_Angeles',   label: '(UTC-08:00) Pacific (LA)',     labelKo: '(UTC-08:00) 태평양 (LA)' },
  { value: 'America/Denver',        label: '(UTC-07:00) Mountain (Denver)', labelKo: '(UTC-07:00) 산악 (덴버)' },
  { value: 'America/Chicago',       label: '(UTC-06:00) Central (Chicago)', labelKo: '(UTC-06:00) 중부 (시카고)' },
  { value: 'America/New_York',      label: '(UTC-05:00) Eastern (New York)', labelKo: '(UTC-05:00) 동부 (뉴욕)' },
  { value: 'America/Caracas',       label: '(UTC-04:30) Caracas',          labelKo: '(UTC-04:30) 카라카스' },
  { value: 'America/Halifax',       label: '(UTC-04:00) Atlantic (Halifax)', labelKo: '(UTC-04:00) 대서양 (핼리팩스)' },
  { value: 'America/St_Johns',      label: '(UTC-03:30) Newfoundland',     labelKo: '(UTC-03:30) 뉴펀들랜드' },
  { value: 'America/Sao_Paulo',     label: '(UTC-03:00) Brasilia',         labelKo: '(UTC-03:00) 브라질리아' },
  { value: 'Atlantic/South_Georgia', label: '(UTC-02:00) South Georgia',   labelKo: '(UTC-02:00) 사우스조지아' },
  { value: 'Atlantic/Azores',       label: '(UTC-01:00) Azores',           labelKo: '(UTC-01:00) 아조레스' },
  { value: 'UTC',                   label: '(UTC+00:00) UTC / London',     labelKo: '(UTC+00:00) UTC / 런던' },
  { value: 'Europe/Paris',          label: '(UTC+01:00) Central Europe (Paris)', labelKo: '(UTC+01:00) 중앙유럽 (파리)' },
  { value: 'Europe/Helsinki',       label: '(UTC+02:00) Eastern Europe (Helsinki)', labelKo: '(UTC+02:00) 동유럽 (헬싱키)' },
  { value: 'Europe/Moscow',         label: '(UTC+03:00) Moscow',           labelKo: '(UTC+03:00) 모스크바' },
  { value: 'Asia/Tehran',           label: '(UTC+03:30) Tehran',           labelKo: '(UTC+03:30) 테헤란' },
  { value: 'Asia/Dubai',            label: '(UTC+04:00) Dubai',            labelKo: '(UTC+04:00) 두바이' },
  { value: 'Asia/Kabul',            label: '(UTC+04:30) Kabul',            labelKo: '(UTC+04:30) 카불' },
  { value: 'Asia/Karachi',          label: '(UTC+05:00) Karachi',          labelKo: '(UTC+05:00) 카라치' },
  { value: 'Asia/Kolkata',          label: '(UTC+05:30) India (Mumbai)',   labelKo: '(UTC+05:30) 인도 (뭄바이)' },
  { value: 'Asia/Kathmandu',        label: '(UTC+05:45) Kathmandu',        labelKo: '(UTC+05:45) 카트만두' },
  { value: 'Asia/Dhaka',            label: '(UTC+06:00) Dhaka',            labelKo: '(UTC+06:00) 다카' },
  { value: 'Asia/Yangon',           label: '(UTC+06:30) Yangon',           labelKo: '(UTC+06:30) 양곤' },
  { value: 'Asia/Bangkok',          label: '(UTC+07:00) Bangkok',          labelKo: '(UTC+07:00) 방콕' },
  { value: 'Asia/Shanghai',         label: '(UTC+08:00) China (Shanghai)', labelKo: '(UTC+08:00) 중국 (상하이)' },
  { value: 'Asia/Tokyo',            label: '(UTC+09:00) Japan (Tokyo)',    labelKo: '(UTC+09:00) 일본 (도쿄)' },
  { value: 'Asia/Seoul',            label: '(UTC+09:00) Korea (Seoul)',    labelKo: '(UTC+09:00) 한국 (서울)' },
  { value: 'Australia/Adelaide',    label: '(UTC+09:30) Adelaide',         labelKo: '(UTC+09:30) 애들레이드' },
  { value: 'Australia/Sydney',      label: '(UTC+10:00) Sydney',           labelKo: '(UTC+10:00) 시드니' },
  { value: 'Pacific/Noumea',        label: '(UTC+11:00) Noumea',           labelKo: '(UTC+11:00) 누메아' },
  { value: 'Pacific/Auckland',      label: '(UTC+12:00) Auckland',         labelKo: '(UTC+12:00) 오클랜드' },
  { value: 'Pacific/Tongatapu',     label: '(UTC+13:00) Tonga',            labelKo: '(UTC+13:00) 통가' },
];

export function timezoneLabel(opt: TimezoneOption, lang: 'ko' | 'en'): string {
  return lang === 'ko' ? opt.labelKo : opt.label;
}
