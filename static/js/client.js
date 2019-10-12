'use strict';

window.addEventListener('online', function() {
	console.log('Application got online event, reloading');
	window.location.reload();
});

if (document.readyState == 'complete') {
	load();
} else {
	window.addEventListener('load', load);
}

function load() {
	console.log('Application got ready event');
	window.Nightscout.client.init();
}
