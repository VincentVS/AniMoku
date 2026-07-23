const express = require('express');
const path = require('node:path');
const metadataRoute = require('./routes/metadata');
const childrenRoute = require('./routes/children');
const grandchildrenRoute = require('./routes/grandchildren');
const imagesRoute = require('./routes/images');
const matchRoute = require('./routes/match');

function createApp() {
  const app = express();
  const providerConfig = require(path.join(__dirname, '..', 'config', 'provider.json'));

  app.use(express.json());

  app.get('/', (req, res) => {
    res.json(providerConfig);
  });

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/library/metadata', metadataRoute);
  app.use('/library/metadata', childrenRoute);
  app.use('/library/metadata', grandchildrenRoute);
  app.use('/library/metadata', imagesRoute);
  app.use('/library/metadata', matchRoute);

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      return next(error);
    }

    return res.status(500).json({
      error: error.message || 'Unexpected server error'
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    console.log(`Anime Metadata Provider listening on port ${port}`);
  });
}

module.exports = {
  createApp
};
