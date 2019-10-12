import $ from "jquery";
window.$ = window.$ || $;

window.Nightscout = {
    client: require('../lib/client/clock-client'),
    units: require('../lib/units')(),
};

console.info('Nightscout clock bundle ready');
