import './bundle.source';

import report_plugins from '../lib/report_plugins/';
window.Nightscout.report_plugins = report_plugins();

console.info('Nightscout report bundle ready');
