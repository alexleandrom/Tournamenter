var TAG = _TAG('config.models');

var path = require('path');
var Waterline = require('waterline');

module.exports = function (app, next){
  // Create new waterline ORM
  var waterline = app.waterline = new Waterline();

  // Load All controllers
  var modelsDir = path.join(__dirname, '/../models');
  var models = app.helpers.loader.load(modelsDir);

  // Convert to model object and load into waterline.
  // Inject `id` as a string PK into every model that doesn't define it.
  // Without this, Waterline defaults to integer PK and parseInt('6a...') → NaN → null,
  // breaking all findOne(pk) lookups against MongoDB ObjectId strings.
  var collections = {};
  for(var k in models){
    var model = _.cloneDeep(models[k]);
    model.autoPK = false;
    model.attributes = _.defaults({ id: { type: 'string', primaryKey: true } }, model.attributes || {});
    collections[k] = Waterline.Collection.extend(model);
  }

  // Use modern MongoDB adapter when DB_ADAPTER is sails-mongo or mongo,
  // otherwise fall back to the configured adapter (sails-disk, etc.)
  var adapterName = app.config.adapter || 'sails-disk';
  var isMongoAdapter = adapterName === 'sails-mongo'
    || adapterName === 'waterline-mongo-modern';

  var resolvedAdapter = isMongoAdapter
    ? require('../adapters/waterline-mongo-modern')
    : require(adapterName);

  // Config used in this waterline instance
  var config = {
    adapters: {
      'default': resolvedAdapter,
    },

    connections: {
      default: _.defaults({adapter: 'default'}, app.config.connection),
    },

    defaults: {
      migrate: 'safe',
    },

    collections,
  };

  // Initialize waterline app
  app.waterline.initialize(config, (err, ontology) => {
    if(err)
      return next(err);

    // Expose collections/models to application (Use File name as ID)
    app.models = {};
    for(var id in models){
      app.models[id] = ontology.collections[models[id].identity];
    }

    console.log(TAG, 'Models:', chalk.yellow(_.keys(app.models).join(',')));

    next()
  })
}
