import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import CssWorker from 'monaco-editor/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/language/html/html.worker?worker';
import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
import TsWorker from 'monaco-editor/language/typescript/ts.worker?worker';

self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return new JsonWorker();
      case 'css':
      case 'scss':
      case 'less':
        return new CssWorker();
      case 'html':
      case 'handlebars':
      case 'razor':
        return new HtmlWorker();
      case 'typescript':
      case 'javascript':
        return new TsWorker();
      default:
        return new EditorWorker();
    }
  },
};

// Editor colours come from the app's design tokens (the :root variables in styles.css).
monaco.editor.defineTheme('kovan-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#101010',
    'editorGutter.background': '#101010',
    'editor.lineHighlightBackground': '#181818',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#4a4a4a',
    'editorLineNumber.activeForeground': '#a7a7a7',
    'editor.selectionBackground': '#303030',
    'editor.inactiveSelectionBackground': '#242424',
    'editorIndentGuide.background1': '#1e1e1e',
    'editorIndentGuide.activeBackground1': '#303030',
    'editorWidget.background': '#181818',
    'editorWidget.border': '#303030',
    'editorSuggestWidget.background': '#181818',
    'editorSuggestWidget.border': '#303030',
    'editorSuggestWidget.selectedBackground': '#242424',
    'input.background': '#0b0b0b',
    'input.border': '#303030',
    'scrollbarSlider.background': '#ffffff14',
    'scrollbarSlider.hoverBackground': '#ffffff22',
    'minimap.background': '#101010',
    'diffEditor.insertedTextBackground': '#30a46c26',
    'diffEditor.removedTextBackground': '#e5484d26',
    'diffEditor.insertedLineBackground': '#30a46c14',
    'diffEditor.removedLineBackground': '#e5484d14',
  },
});
monaco.editor.defineTheme('kovan-light', {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'editor.background': '#ffffff',
    'editorGutter.background': '#ffffff',
    'editor.lineHighlightBackground': '#f6f6f7',
    'editor.lineHighlightBorder': '#00000000',
    'editorLineNumber.foreground': '#a1a1aa',
    'editorLineNumber.activeForeground': '#52525b',
    'editor.selectionBackground': '#e4e4e7',
    'editorWidget.background': '#f6f6f7',
    'editorWidget.border': '#d0d0d6',
    'minimap.background': '#ffffff',
    'diffEditor.insertedTextBackground': '#30a46c2e',
    'diffEditor.removedTextBackground': '#e5484d2e',
  },
});

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const applyTheme = () => monaco.editor.setTheme(darkQuery.matches ? 'kovan-dark' : 'kovan-light');
applyTheme();
darkQuery.addEventListener('change', applyTheme);

export { monaco };
