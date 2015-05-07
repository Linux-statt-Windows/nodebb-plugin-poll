var S = require('string'),
	XRegExp = require('xregexp').XRegExp,
	async = require('async'),
	cron = require('cron').CronJob,

	NodeBB = require('./nodebb'),
	db = NodeBB.db,
	fs = module.parent.parent.require('fs'),
	path = module.parent.parent.require('path'),

	Config = require('./config'),
	Backend = require('./backend'),

	pollRegex = XRegExp('(?:(?:\\[poll[ ]*(?<settings>.*?)\\])\n(?<content>(?:-.+?\n)+)(?:\\[\/poll\\]))', 'g'),
	pollSettingsRegex = XRegExp('(?<key>.+?)="(?<value>.+?)"', 'g'),
	translations,

	pollSettingsMap = {
		max: {
			key: 'maxvotes',
			test: function(value) {
				return !isNaN(value);
			}
		},
		title: {
			key: 'title',
			test: function(value) {
				return value.length > 0;
			}
		},
		end: {
			key: 'end',
			test: function(value) {
				return (!isNaN(value) && parseInt(value, 10) > Date.now());
			}
		}
	};

var Utils = {
	app: null,
	hasPoll: function(post) {
		return XRegExp.exec(post, pollRegex) !== null;
	},
	parsePoll: function(post, callback) {
		var match = XRegExp.exec(post, pollRegex);
		if (match !== null) {
			async.parallel({
				options: function(next) {
					Utils.parseOptions(match.content, next);
				},
				settings: function(next) {
					Utils.parseSettings(match.settings, next);
				}
			}, callback);
		} else {
			callback(null, null);
		}
	},
	parseOptions: function(raw, callback) {
		var maxOptions = Config.settings.get('limits.maxOptions'),
			pollOptions = [],
			rawOptions = S(raw).stripTags().s.split('\n');

		for (var i = 0, l = rawOptions.length; i < l; i++) {
			if (rawOptions[i].length > 0) {
				var option = S(rawOptions[i].split('-')[1]).trim().s;
				if (option.length > 0) {
					pollOptions.push(option);
				}
			}
		}

		if (pollOptions.length > maxOptions) {
			pollOptions = pollOptions.slice(0, maxOptions - 1);
		}

		callback(null, pollOptions);
	},
	parseSettings: function(raw, callback) {
		var pollSettings = Config.settings.get('defaults');

		raw = S(raw).stripTags().s;

		callback(null, XRegExp.forEach(raw, pollSettingsRegex, function(match) {
			var key = S(match.key).trim().s,
				value = S(match.value).trim().s;

			if (key.length > 0 && value.length > 0 && pollSettingsMap.hasOwnProperty(key)) {
				if (pollSettingsMap[key].test(value)) {
					this[pollSettingsMap[key].key] = value;
				}
			}
		}, pollSettings));
	},
	preparePoll: function(postData, pollData) {
		return {
			title: pollData.title,
			uid: postData.uid,
			tid: postData.tid,
			pid: postData.pid,
			deleted: 0,
			ended: 0,
			timestamp: postData.timestamp,
			settings: pollData.settings,
			options: pollData.options.map(function(val, i) {
				return {
					id: i,
					title: val
				};
			})
		};
	},
	isFirstPost: function(pid, tid, callback) {
		//Check if topic is empty or if post is first post
		db.getSortedSetRange('tid:' + tid + ':posts', 0, 0, function(err, pids) {
			if(err) {
				return callback(err);
			}

			callback(null, pids.length === 0 || parseInt(pids[0], 10) === parseInt(pid, 10));
		});
	},
	removeMarkup: function(content) {
		return XRegExp.replace(content, pollRegex, '');
	},
	scheduler: {
		init: function() {
			Backend.getScheduledPolls(function(err, pollids) {
				if (pollids.length > 0) {
					for (var i = 0, l = pollids.length; i < l; i++) {
						Utils.scheduler.add(pollids[i]);
					}
				}
			});
		},
		add: function(pollid) {
			if (Object.keys(Utils.scheduler.jobs).indexOf(pollid.toString()) !== -1) {
				return;
			}

			Backend.getPollSettings(pollid, function(err, settings) {
				if (err) {
					return console.log(err.stack);
				}
				if (!settings) {
					return console.log('Poll ID - ' + pollid + ' has no settings!');
				}
				var now = Date.now(),
					end = parseInt(settings.end, 10);
				if (end < now) {
					Utils.scheduler.end(pollid);
				} else {
					Utils.scheduler.jobs[pollid] = new cron(new Date(end), function() {
						Utils.scheduler.end(pollid);
					}, null, true);
				}
			});
		},
		end: function(pollid) {
			var index = Object.keys(Utils.scheduler.jobs).indexOf(pollid.toString());
			if (index !== -1 && Utils.scheduler.jobs[pollid] !== undefined) {
				Utils.scheduler.jobs[pollid].stop();
				Utils.scheduler.jobs[pollid] = undefined;
			}
			Backend.endPoll(pollid);
		},
		jobs: {}
	},
	loadTranslations: function(){
		Utils.translations = { };
		var languagesPath = path.resolve(__dirname, '../public/language');

		var langs = fs.readdirSync(languagesPath);
		for (var l in langs) {
			var lang = langs[l],
				langPath = languagesPath + '/' + lang;

			if (fs.lstatSync(langPath).isDirectory()) {
				var files = fs.readdirSync(langPath);
				for (var f in files) {
					var file = files[f],
						filePath = langPath + '/' + file;

					if (!fs.lstatSync(filePath).isDirectory() && file.slice(-5) === '.json') {
						try {
							Utils.translations[langs[l]] = JSON.parse(fs.readFileSync(filePath), 'utf8');
							NodeBB.translator.addTranslation(lang, file.slice(0, -5), Utils.translations[langs[l]]);
						}catch (e){
							console.log("Poll: Error reading " + filePath + ": " + e);
						}
					}
				}
			}
		}
	}
};

module.exports = Utils;
