/**
 * 按需注册的 highlight.js core 实例（v3.73 性能优化）。
 *
 * 全量 `import hljs from 'highlight.js'` 会拉进全部 ~190 种语言定义：bundle 体积大、
 * 模块执行 ~270ms 且落在渲染进程首帧路径上。此处改从 highlight.js/lib/core 引入
 * 核心，只注册项目白名单内的 19 种语言；renderMarkdown（markdown 代码块高亮）与
 * sideBySideDiff（diff 单行高亮）共享同一实例与同一注册集。
 *
 * 兼容性：两个调用方在 highlight 前都有 getLanguage 判断，未注册语言自动降级为
 * 转义展示——行为与全量版一致，只是白名单外的语言不再高亮（白名单本就刻意收窄）。
 */
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import cLang from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdownLang from 'highlight.js/lib/languages/markdown';
import diffLang from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('python', python);
hljs.registerLanguage('java', java);
hljs.registerLanguage('go', go);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('c', cLang);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('diff', diffLang);
hljs.registerLanguage('dockerfile', dockerfile);

export { hljs };
