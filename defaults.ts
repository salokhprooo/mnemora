import type { CardTemplateDef, NoteKind, ShortcutMap, UserSettings } from '../types';

export const DEFAULT_SHORTCUTS: ShortcutMap = {
  showAnswer: ' ',
  again: '1',
  hard: '2',
  good: '3',
  easy: '4',
  undo: 'z',
};

export const DEFAULT_SETTINGS: UserSettings = {
  theme: 'system',
  language: 'en',
  daily_goal: 50,
  reminders_enabled: false,
  reminder_time: '19:00',
  show_intervals: true,
  show_timer: true,
  answer_buttons: 4,
  auto_play_audio: true,
  card_font_size: 22,
  card_max_width: 720,
  rollover_hour: 4,
  compact: false,
  shortcuts: DEFAULT_SHORTCUTS,
  fsrs_params: null,
  auto_sync: true,
};

export interface BuiltinNoteType {
  key: string;
  name: string;
  kind: NoteKind;
  fields: string[];
  templates: CardTemplateDef[];
  css: string;
}

export const BASE_CSS = `.card { text-align: center; }`;

export const BUILTIN_NOTE_TYPES: BuiltinNoteType[] = [
  {
    key: 'basic',
    name: 'Basic',
    kind: 'basic',
    fields: ['Front', 'Back'],
    templates: [{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id="answer">{{Back}}' }],
    css: BASE_CSS,
  },
  {
    key: 'basic_reversed',
    name: 'Basic (and reversed card)',
    kind: 'basic_reversed',
    fields: ['Front', 'Back'],
    templates: [
      { name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id="answer">{{Back}}' },
      { name: 'Card 2', front: '{{Back}}', back: '{{FrontSide}}<hr id="answer">{{Front}}' },
    ],
    css: BASE_CSS,
  },
  {
    key: 'basic_optional_reversed',
    name: 'Basic (optional reversed card)',
    kind: 'basic_optional_reversed',
    fields: ['Front', 'Back', 'Add Reverse'],
    templates: [
      { name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}<hr id="answer">{{Back}}' },
      {
        name: 'Card 2',
        front: '{{#Add Reverse}}{{Back}}{{/Add Reverse}}',
        back: '{{FrontSide}}<hr id="answer">{{Front}}',
      },
    ],
    css: BASE_CSS,
  },
  {
    key: 'cloze',
    name: 'Cloze',
    kind: 'cloze',
    fields: ['Text', 'Extra'],
    templates: [
      { name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}<br>{{Extra}}' },
    ],
    css: BASE_CSS + `\n.cloze { font-weight: 700; color: rgb(var(--c-brand)); }`,
  },
  {
    key: 'multiple_choice',
    name: 'Multiple choice',
    kind: 'multiple_choice',
    // The study screen renders these fields as shuffled, tappable options (see MultipleChoice component).
    fields: ['Question', 'Correct', 'Wrong 1', 'Wrong 2', 'Wrong 3', 'Explanation'],
    templates: [
      {
        name: 'Choice',
        front: '{{Question}}',
        back: '{{Question}}<hr id="answer"><b>{{Correct}}</b><br>{{Explanation}}',
      },
    ],
    css: BASE_CSS,
  },
  {
    key: 'image',
    name: 'Image card',
    kind: 'image',
    fields: ['Image', 'Prompt', 'Answer', 'Extra'],
    templates: [
      { name: 'Image', front: '{{Image}}<br>{{Prompt}}', back: '{{FrontSide}}<hr id="answer">{{Answer}}<br>{{Extra}}' },
    ],
    css: BASE_CSS + `\n.card img { max-width: 100%; max-height: 50vh; border-radius: 8px; }`,
  },
  {
    key: 'image_occlusion',
    name: 'Image occlusion',
    kind: 'image_occlusion',
    // "Occlusions" holds JSON: [{x,y,w,h,label?}] in 0..1 image-relative coordinates. One card per region.
    fields: ['Image', 'Occlusions', 'Header', 'Extra'],
    templates: [{ name: 'Occlusion', front: '{{Header}}', back: '{{Header}}<br>{{Extra}}' }],
    css: BASE_CSS,
  },
  {
    key: 'audio',
    name: 'Audio card',
    kind: 'audio',
    fields: ['Audio', 'Prompt', 'Answer', 'Extra'],
    templates: [
      { name: 'Audio', front: '{{Audio}}<br>{{Prompt}}', back: '{{FrontSide}}<hr id="answer">{{Answer}}<br>{{Extra}}' },
    ],
    css: BASE_CSS,
  },
];

export const DEFAULT_DECK_NAME = 'Default';
