import { Meteor } from "meteor/meteor"
import { Mongo } from "meteor/mongo"
import { Utilities } from "../../utilities/"

/*
	Potential Optimization
		1- if server is not dominant, it should check again when the current server dominance expires rather than poll the db
		2- when setAsActive is called - its often called once for each queue - should be reduced to just one call

	Non-problematic bug
		- When the queue starts, if there is more than one queue running,
		they will all call dominator.isActive at near same time
		- The problem with this, is that because the functions are milliseconds apart,
		MongoDB will try to run all the upserts in `setAsActive` at once
		- As a result, the "jobs_dominator_3" collection has a unique index on serverId
		- Sometimes, MongoDB might throw an error because an insert was attempted
		over a non-unique index - however, this is harmless
		- To prevent annoying console messages, `dominator.setAsActive` has been wrapped in try/catch
*/

const dominator = {
	serverId: null,
	collection: undefined,
	initialized: false
}

let debugMode = false;

dominator.initialize = async function () {
	if (debugMode) console.log("dominator.initialize", this)

	const self = this;

	// ensure that we're not doing it twice
	if (self.initialized) return;

	// First, initialize the collection
	if (Utilities.config.remoteCollection) {
		const db = new MongoInternals.RemoteCollectionDriver(Utilities.config.remoteCollection);
		self.collection = new Mongo.Collection("jobs_dominator_3", { _driver: db });
	} else {
		self.collection = new Mongo.Collection("jobs_dominator_3");
	}

	// Then, ensure an index is set
	await self.collection.createIndexAsync({serverId: 1}, {unique: 1});
	

	// Finally, set the serverId
	self.serverId = Utilities.config.getServerId();
}
		
dominator.getActive = async function () {
	if (debugMode) console.log("dominator.getActive");

	const self = this;

	return await self.collection.findOneAsync({}, {
		sort: {
			lastPing: -1,
		}
	});
}

// This will automatically remove dominator logs
// to prevent database from getting too big
dominator.purge = function () {
	if (debugMode) console.log("dominator.purge")

	const self = this;

	Meteor.setTimeout(async function () {
		return await self.collection.removeAsync({
			serverId: {
				$ne: self.serverId
			}
		})
	}, 5000);
}

dominator.setAsActive = async function () {
	if (debugMode) console.log("dominator.setAsActive")

	const self = this;
	const lastPing = new Date();

	try { 
		const result = await self.collection.upsertAsync({
			serverId: self.serverId
		}, {
			$set: {
				lastPing: lastPing,
			},
			$setOnInsert: {
				created: lastPing
			}
		});

		if (result) {
			self.lastPing = lastPing;
		}

		if (Utilities.config.autoPurge) {
			dominator.purge();
		}

		return result;
	} catch (e) {
		// https://www.youtube.com/watch?v=SHs6O6jC7Y8
		if (debugMode) console.log("dominator.purgeError", e);
		return false;
	}
}

dominator.isActive = async function () {
	if (debugMode) console.log("dominator.isActive")

	const self = this;

	// since Meteor runs only one server in development,
	// we should set dominator as active immediately, otherwise
	// it would wait the `lastPing` to surpass `maxWait`
	if (Meteor.isDevelopment && !Utilities.config.disableDevelopmentMode) {
		return await self.setAsActive();
	}

	// if the last ping was less than 10 seconds ago,
	// then assume that server is dominant
	if (self.lastPing && Utilities.config.gracePeriod) {
		const lastPing = new Date(self.lastPing);
		const gracePeriod = lastPing.setSeconds(lastPing.getSeconds() + Utilities.config.gracePeriod);

		if (new Date() < gracePeriod) {
			if (debugMode) console.log('dominator.within grace period')
			return true;
		}
	}

	// otherwise - its business as usual
	const doc = await self.getActive();

	// if the doc is itself, maintain dominance
	if (!doc || doc.serverId === self.serverId) {
		return await self.setAsActive();
	} else {
		// if a server isn't maintaining dominance, take it
		const timeGap = new Date () - doc.lastPing;
		const maxTimeGap = Utilities.config.maxWait;

		if (timeGap >= maxTimeGap) {
			return await self.setAsActive();
		}
	}
}

// this function is only called manually

dominator.reset =  function () {
	if (debugMode) console.log("dominator.reset")

	this.serverId = Utilities.config.getServerId(true);
}

export { dominator }
