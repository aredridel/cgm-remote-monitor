import '../static/css/drawer.css';
import '../static/css/dropdown.css';
import '../static/css/sgv.css';

import _ from 'lodash';
import d3 from 'd3';
import storage from 'js-storage';
import moment from 'moment-timezone';

import client from '../lib/client';
import admin_plugins_ from '../lib/admin_plugins/';
import units_ from '../lib/units';

window._ = _;
window.d3 = d3;
window.Storage = storage;
window.moment = moment;

window.Nightscout = window.Nightscout || {};

window.Nightscout = {
    client, 
    units: units_(),
    admin_plugins: admin_plugins_()
};

console.info('Nightscout bundle ready');
