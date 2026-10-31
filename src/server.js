const express = require('express');
const path = require('node:path');
const logger = require('./utils/logger');
const metadataRoute = require('./routes/metadata');
const childrenRoute = require('./routes/children');
const grandchildrenRoute = require('./routes/grandchildren');
const imagesRoute = require('./routes/images');
const matchRoute = require('./routes/match');
const { version } = require('../package.json');

// Plex can append its auth token to the query string; keep it out of the logs.
const SECRET_QUERY_PARAMS = /([?&](?:X-Plex-Token|api_key|token)=)[^&]*/gi;

function redactUrl(url) {
  return String(url || '').replace(SECRET_QUERY_PARAMS, '$1[redacted]');
}

function createApp() {
  const app = express();
  const providerConfig = require(path.join(__dirname, '..', 'config', 'provider.json'));

  app.disable('x-powered-by');
  app.use(express.json());

  app.use((req, res, next) => {
    const startedAt = Date.now();
    res.on('finish', () => {
      logger.info({ method: req.method, url: redactUrl(req.originalUrl), status: res.statusCode, durationMs: Date.now() - startedAt }, 'request completed');
    });
    next();
  });

  app.get('/', (req, res) => {
    res.json({ MediaProvider: { ...providerConfig.MediaProvider, version } });
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

    // Client errors (malformed JSON body, unknown rating key) keep their message;
    // anything else is answered generically so internals never reach the response.
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    const log = status === 500 ? logger.error.bind(logger) : logger.warn.bind(logger);
    log({ method: req.method, url: redactUrl(req.originalUrl), err: error }, 'request failed');

    return res.status(status).json({
      error: status === 500 ? 'Unexpected server error' : error.message
    });
  });

  return app;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => {
    logger.info({ port, version }, 'AniMoku listening');
  });
}

module.exports = {
  createApp
};
