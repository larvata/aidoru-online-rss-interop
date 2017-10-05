process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const Koa = require('koa');
const route = require('koa-route');
const send = require('koa-send');

const aoService = require('./services/aoService');
const config = require('./config');

const app = new Koa();
app.use(route.get('/feeds.rss', (ctx) => {
  ctx.set('Content-Type', 'text/xml; charset=UTF-8');
  const xml = aoService.getFeedContentXML();

  ctx.body = xml;
}));

app.use(route.get('/torrent/:torrentFileName', async (ctx, torrentFileName) => {
  console.log('try download', torrentFileName);
  const filePath = `torrent-cache/${torrentFileName}`;
  await send(ctx, filePath);
}));

app.listen(config.PORT);
aoService.start();
console.log(`server listen at: http://localhost:${config.PORT}`);
