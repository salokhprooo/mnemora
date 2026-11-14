/**
 * Minimal i18n. Only navigation and the study screen are translated so far (English, Uzbek, Russian);
 * everything else is English. Adding a language = adding a column here; adding a string = adding a row.
 */
import type { Language } from '../types';

type Dict = Record<string, { en: string; uz: string; ru: string }>;

export const STRINGS: Dict = {
  'nav.Home': { en: 'Home', uz: 'Bosh sahifa', ru: 'Главная' },
  'nav.Decks': { en: 'Decks', uz: 'To‘plamlar', ru: 'Колоды' },
  'nav.Study': { en: 'Study', uz: 'O‘rganish', ru: 'Учёба' },
  'nav.Browse': { en: 'Browse', uz: 'Ko‘rish', ru: 'Обзор' },
  'nav.Statistics': { en: 'Statistics', uz: 'Statistika', ru: 'Статистика' },
  'nav.Add Card': { en: 'Add Card', uz: 'Karta qo‘shish', ru: 'Добавить' },
  'nav.Import / Export': { en: 'Import / Export', uz: 'Import / Eksport', ru: 'Импорт / Экспорт' },
  'nav.Settings': { en: 'Settings', uz: 'Sozlamalar', ru: 'Настройки' },
  'nav.More': { en: 'More', uz: 'Yana', ru: 'Ещё' },
  'nav.Add': { en: 'Add', uz: 'Qo‘shish', ru: 'Добавить' },
  'study.showAnswer': { en: 'Show answer', uz: 'Javobni ko‘rsatish', ru: 'Показать ответ' },
  'study.again': { en: 'Again', uz: 'Qaytadan', ru: 'Снова' },
  'study.hard': { en: 'Hard', uz: 'Qiyin', ru: 'Трудно' },
  'study.good': { en: 'Good', uz: 'Yaxshi', ru: 'Хорошо' },
  'study.easy': { en: 'Easy', uz: 'Oson', ru: 'Легко' },
  'study.chooseAnswer': { en: 'Choose an answer (keys 1–4)', uz: 'Javobni tanlang (1–4 tugmalari)', ru: 'Выберите ответ (клавиши 1–4)' },
  'study.done': { en: 'Session complete', uz: 'Mashg‘ulot tugadi', ru: 'Сессия завершена' },
  'study.caughtUp': { en: 'All caught up', uz: 'Hammasi bajarildi', ru: 'Всё повторено' },
};

export const LANGUAGES: { value: Language; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'uz', label: 'O‘zbekcha' },
  { value: 'ru', label: 'Русский' },
];

export function translate(lang: Language, key: string): string {
  const row = STRINGS[key];
  if (!row) return key.replace(/^[a-z]+\./, '');
  return row[lang] || row.en;
}
