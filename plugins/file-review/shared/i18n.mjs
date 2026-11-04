const messages = {
  'zh-CN': {
    title: '整会话文件审查', session: '整个会话',
    files: '{n} 个文件', edits: '{n} 次修改', number: '第 {n} 次修改',
    empty: '没有文件修改记录', loading: '正在读取修改记录…',
    refresh: '刷新',
    evidence: '部分成功的文件操作没有审查证据，无法在这里展示或撤销。',
    snapshot: '展示工具执行时保存的修改记录；加减行按每次操作累计，不代表当前工作树的净差异。',
    binary: '二进制文件，无法显示逐行差异。', truncated: '差异过大，记录已截断。',
    noLines: '此记录没有逐行差异。', rollback: '撤销本次修改', rollingBack: '正在撤销…',
    unavailable: '撤销快照不可用，未修改文件。', rollbackUnavailable: '此修改无法撤销',
    rolledBack: '已撤销', alreadyRolledBack: '这次修改已经撤销。',
    success: '已安全撤销本次修改。', conflict: '文件在这次修改后已发生变化，未执行撤销。',
    error: '读取失败', rollbackError: '撤销失败', unknownStatus: '宿主返回未知撤销状态，请刷新后核对。',
    localOnly: '请打开一个本地会话以审查文件改动。',
    added: '新增', modified: '修改', deleted: '删除',
    bridgeMissing: '请在这是一个助手中打开此插件。',
  },
  en: {
    title: 'Session file review', session: 'Entire session',
    files: '{n} files', edits: '{n} changes', number: 'Change {n}',
    empty: 'No file change records', loading: 'Loading change records…',
    refresh: 'Refresh',
    evidence: 'Some successful file operations have no review evidence and cannot be displayed or rolled back here.',
    snapshot: 'Records were saved when each tool ran. Line counts add up each operation and do not represent the current working tree’s net diff.',
    binary: 'Binary file. Line diff is unavailable.', truncated: 'The diff was too large and was truncated.',
    noLines: 'This record contains no line diff.', rollback: 'Undo this change', rollingBack: 'Undoing…',
    unavailable: 'The rollback snapshot is unavailable. The file was not changed.', rollbackUnavailable: 'Rollback unavailable',
    rolledBack: 'Undone', alreadyRolledBack: 'This change was already undone.',
    success: 'This change was safely undone.', conflict: 'The file changed after this operation. Rollback was not performed.',
    error: 'Unable to load', rollbackError: 'Rollback failed', unknownStatus: 'The host returned an unknown rollback status. Refresh to verify.',
    localOnly: 'Open a local session to review file changes.',
    added: 'Added', modified: 'Modified', deleted: 'Deleted',
    bridgeMissing: 'Open this plugin inside this-is-a-agent.',
  },
};
export const language = (locale) => String(locale || '').toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
export function translate(locale, key, values = {}) {
  return (messages[language(locale)][key] || key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ''));
}
