const fs = require('fs');

const FeedParser = require('feedparser');
const RSS = require('rss');
const _request = require('request');

const jar = _request.jar();
const request = _request.defaults({ jar });
const config = require('../config');

const FAKE_FINGERPRINT = (
  Math.random().toString(16).substring(2, 10)
  + Math.random().toString(16).substring(2, 10)
  + Math.random().toString(16).substring(2, 10)
  + Math.random().toString(16).substring(2, 10));

const AO_URL_BASE = 'https://aidoru-online.me/';
const AO_URL_ACCOUNT_UPD = 'https://aidoru-online.me/account-upd.php';
const AO_URL_LOGIN_PAGE = 'https://aidoru-online.me/login.php';
const AO_URL_LOGIN_ENDPOINT = 'https://aidoru-online.me/login.php?type=login';
const AO_URL_RSS = 'https://aidoru-online.me/rss.php';
const AO_SERVICE_RETRY_TIMEOUT = 5 * 60 * 1000;


const HTTP_STATUS_CODE = {
  OK: 200,
};

let feedContentRaw = null;
let feedContentXML = null;

const requestPromise = options => new Promise((resolve, reject) => {
  request(options, (err, res) => {
    if (err) {
      return reject(err);
    }
    if (res.statusCode !== HTTP_STATUS_CODE.OK) {
      return reject(new Error(`status code wrong: ${res.statusCode}`));
    }
    return resolve(res);
  });
});


const findSessionId = (setCookieList) => {
  let result = '';
  setCookieList.some((cookie) => {
    const match = cookie.match(/sid=(\S+);/);
    if (match) {
      [, result] = match;
      return true;
    }
    return false;
  });
  return result;
};

const checkLoginState = () => {
  return requestPromise({
    url: AO_URL_BASE,
  }).then((res) => {
    const authenticated = !res.headers.refresh;
    return { authenticated };
  });
};

const loadLoadingPage = () => {
  return requestPromise({
    url: AO_URL_LOGIN_PAGE,
  });
};

const accountUpdate = () => {
  return requestPromise({
    method: 'POST',
    url: AO_URL_ACCOUNT_UPD,
    form: {
      f: FAKE_FINGERPRINT,
    },
    headers: {
      Referer: 'https://aidoru-online.me/login.php',
      Origin: 'https://aidoru-online.me',
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
};

const doLogin = () => {
  return requestPromise({
    method: 'POST',
    url: AO_URL_LOGIN_ENDPOINT,
    form: {
      username: config.AO_USERNAME,
      password: config.AO_PASSWORD,
      do: 'login',
      language: '',
      // csrfp_token: csrfpToken,
    },
    headers: {
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'accept-encoding': 'gzip, deflate, br',
      'accept-language': 'en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7,zh;q=0.6',
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://aidoru-online.me',
      referer: 'https://aidoru-online.me/login.php',
      'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/66.0.3343.3 Safari/537.36',
    },
  }).then((res) => {
    const setCookieList = res.headers['set-cookie'];
    const sid = findSessionId(setCookieList);
    const authenticated = !!sid;
    return { authenticated };
  });
};

// check the user current login state
// if not logged in
// try get the corrent csrf and login in
const keepLoginState = () => {
  return checkLoginState()
    .then((result) => {
      const { authenticated } = result;
      if (!authenticated) {
        // not logged in, try login first
        // return getCSRFPToken().then(ret => login(ret.csrfpToken));
        return loadLoadingPage().then(accountUpdate).then(doLogin);
      }

      // console.log('keepLoginState: ', JSON.stringify(result, null, 2));
      return result;
    });
};

// feed fetch
const loadRSS = () => {
  // console.log('- loadRSS');
  return new Promise((resolve, reject) => {
    const result = {
      authenticated: false,
      error: null,
      rssText: null,
      feed: {
        meta: null,
        items: [],
      },
    };

    const feedparser = new FeedParser();
    const req = request({
      url: AO_URL_RSS,
      gzip: true,
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,ja;q=0.6',
        referer: 'https://aidoru-online.me/',
        'upgrade-insecure-requests': 1,
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3218.0 Safari/537.36',
      },
    });
    req.on('error', (err) => {
      // console.log('-> loadRSS error:', err.message);
      result.error = err.message;
      return resolve(result);
    });

    req.on('response', (res) => {
      // console.log('-> loadRSS response', res.statusCode);
      if (res.statusCode !== HTTP_STATUS_CODE.OK) {
        result.error = `status code wrong: ${res.statusCode}`;
        return resolve(resolve);
      }
      req.pipe(feedparser);
    });

    feedparser.on('readable', () => {
      result.feed.meta = feedparser.meta;
      let item = null;
      while (item = feedparser.read()) {
        result.feed.items.push(item);
      }
    });

    feedparser.on('error', (err) => {
      console.log('>>>', err);
      // console.log(feedparser);
      result.error = err.message;
      return resolve(result);
    });

    feedparser.on('end', () => {
      // console.log('-> loadRSS readable');
      return resolve(result);
    });
  });
};


// guid: rss.item.guid
const getTorrentId = (guid) => {
  let result = null;
  const match = guid.match(/id=(\d+)&/);
  if (match) {
    [, result] = match;
  }
  return result;
};

// download torrent file from AO by the torrent
const downloadTorrentFile = (feedItem) => {
  const { link, guid } = feedItem;
  const torrentId = getTorrentId(link);

  const result = {
    guid,
    torrentId,
  };

  const torrentUrl = `https://aidoru-online.me/download.php?id=${torrentId}`;
  const filePath = `torrent-cache/${torrentId}.torrent`;
  return new Promise((resolve, reject) => {
    if (fs.existsSync(filePath)) {
      // torrent already exists, skip the download
      return resolve(result);
    }

    const steam = fs.createWriteStream(filePath);
    steam.on('error', () => {
      // unlink the unfinished file
      // console.log('-> torrent download error, unlink the unfinished file.');
      fs.unlink(filePath, (err) => {
        if (err) {
          console.log(err.message);
        }
        console.log(`${filePath} unlinked.`);
      });
    });
    steam.on('finish', () => {
      // console.log('torrent write finished: ', torrentId);
      return resolve(result);
    });
    const req = request.get(torrentUrl);
    req.on('error', (err) => {
      console.log('get torrent file error: ', err.message);
      return resolve(null);
    });
    req.pipe(steam);
  });
};

const doDownloadQueue = (tasks, lastResult) => {
  const result = lastResult || [];
  if (!tasks || tasks.length === 0) {
    // console.log('no more download tasks');
    return Promise.resolve(result);
  }

  const currentTask = tasks[0];
  const restTask = tasks.slice(1);
  return currentTask.then((ret) => {
    result.push(ret);
    return doDownloadQueue(restTask, result);
  });
};

const backgroundWork = () => {
  keepLoginState()
    .then(loadRSS)
    .then((result) => {
      const { feed } = result;
      feedContentRaw = feed;

      const torrentTasks = feed.items.map(downloadTorrentFile);
      return doDownloadQueue(torrentTasks);
    })
    .then((result) => {
      // update the source feed content
      if (feedContentRaw) {
        const rss = new RSS({
          title: 'aidoru online plain',
          description: 'create by aidoru-online-rss-interop',
          link: 'http://github.com/larvata/aidoru-online-rss-interop',
        });
        feedContentRaw.items.forEach((itm) => {
          const r = result.find(ret => ret.guid === itm.guid);
          if (!r) {
            return;
          }

          const url = `http://localhost:${config.PORT}/torrent/${r.torrentId}.torrent`;
          rss.item({
            title: itm.title,
            url,
            guid: itm.guid,
          });
        });
        feedContentXML = rss.xml({ indent: true });
        console.log(new Date().toString(), 'new xml has been updated.');
      }

      setTimeout(backgroundWork, config.CHECK_INTERVAL);
    })
    .catch((err) => {
      console.log('aoService error: ', err);
      console.log('restart aoService after 5 mins');
      setTimeout(backgroundWork, AO_SERVICE_RETRY_TIMEOUT);
    });
};

const aoWorker = {
  start: () => {
    backgroundWork();
  },

  getFeedContentXML: () => {
    return feedContentXML;
  },

};

module.exports = aoWorker;
