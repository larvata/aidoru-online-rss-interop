const fs = require('fs');

const FeedParser = require('feedparser');
const RSS = require('rss');
const _request = require('request');
const config = require('../config');

const jar = _request.jar();
let request = null;
if (config.HTTP_PROXY_HOST && config.HTTP_PROXY_PORT) {
  request = _request.defaults({ jar, proxy: `http://${config.HTTP_PROXY_HOST}:${config.HTTP_PROXY_PORT}` });
}
else {
  request = _request.defaults({ jar });
}

const AO_URL_BASE = 'https://aidoru-online.org/';
const AO_URL_LOGIN_ENDPOINT = 'https://aidoru-online.org/login.php?type=login';
const AO_URL_LOGIN_PAGE = 'https://aidoru-online.org/login.php';
const AO_URL_RSS = 'https://aidoru-online.org/rss.php';
const AO_SERVICE_RETRY_TIMEOUT = 5 * 60 * 1000;

const HTTP_STATUS_CODE = {
  OK: 200,
};

let feedContentRaw = null;
let feedContentXML = null;


const findSessionId = (setCookieList) => {
  let result = '';
  setCookieList.some((cookie) => {
    const match = cookie.match(/sid=(\S+);/);
    if (match) {
      result = match[1];
      return true;
    }
    return false;
  });
  return result;
};

const checkLoginState = () => {
  // console.log('- checkLoginState');
  return new Promise((resolve, reject) => {
    request.get(AO_URL_BASE, (err, res, body) => {
      const result = {
        authenticated: false,
        csrfpToken: null,
        error: null,
      };
      if (err) {
        result.error = err.message;
      } else if (res.statusCode !== HTTP_STATUS_CODE.OK) {
        result.error = `status code wrong: ${res.statusCode}`;
      } else {
        // when session not authenticated a set cookie header will attached to the response header

        // // get csrpf
        // const cookies = jar.getCookies('https://aidoru-online.org');
        // const csrfpCookie = cookies.find(c => (c.key === 'csrfp_token'));
        // result.csrfpToken = csrfpCookie.value;

        const authenticated = !res.headers.refresh;
        result.authenticated = authenticated;
      }

      // console.log('-> checkLoginState:', JSON.stringify(result));
      if (result.error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
};

// get the csrpf token from login page
const getCSRFPToken = () => {
  return new Promise((resolve, reject) => {
    request.get(AO_URL_LOGIN_PAGE, (err, res, body) => {
      const result = {
        authenticated: false,
        csrfpToken: null,
        error: null,
      };

      if (err) {
        result.error = err.message;
      } else if (res.statusCode !== HTTP_STATUS_CODE.OK) {
        result.error = `status code wrong: ${res.statusCode}`;
      } else {
        // get csrpf
        const cookies = jar.getCookies(AO_URL_BASE);
        const csrfpCookie = cookies.find(c => (c.key === 'csrfp_token'));
        result.csrfpToken = csrfpCookie.value;

        // set ufp cookie which is required for login
        jar.setCookie(`ufp=${config.AO_UFP}`, AO_URL_BASE);
      }

      // console.log('-> getCSRFPToken:', JSON.stringify(result));
      if (result.error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
};

const login = (csrfpToken) => {
  // console.log('- login');
  return new Promise((resolve, reject) => {
    const result = {
      authenticated: false,
      error: null,
    };
    request.post({
      url: AO_URL_LOGIN_ENDPOINT,
      form: {
        username: config.AO_USERNAME,
        password: config.AO_PASSWORD,
        do: 'login',
        csrfp_token: csrfpToken,
      },
      headers: {
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9,ja;q=0.8,zh-CN;q=0.7,zh;q=0.6',
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'https://aidoru-online.org',
        referer: 'https://aidoru-online.org/login.php',
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/66.0.3343.3 Safari/537.36',
      },
    }, (err, res, body) => {
      if (err) {
        result.error = err.message;
      } else if (res.statusCode !== HTTP_STATUS_CODE.OK) {
        result.error = `status code wrong: ${res.statusCode}`;
      } else {
        const setCookieList = res.headers['set-cookie'];
        const sid = findSessionId(setCookieList);
        const authenticated = !!sid;
        result.authenticated = authenticated;
      }

      // console.log('-> login:', JSON.stringify(result));
      if (result.error) {
        return reject(result);
      }
      return resolve(result);
    });
  });
};

// check the user current login state
// if not logged in
// try get the corrent csrf and login in
const keepLoginState = () => {
  return checkLoginState()
    .then((result) => {
      const { authenticated, csrfpToken, error } = result;
      if (!authenticated) {
        // not logged in, try login first
        return getCSRFPToken().then(ret => login(ret.csrfpToken));
      }

      // console.log('keepLoginState: ', JSON.stringify(result, null, 2));
      return Promise.resolve(result);
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
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,ja;q=0.6',
        'referer': 'https://aidoru-online.org/',
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
      } else {
        // console.log(res.body);
        req.pipe(feedparser);
      }
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

  const torrentUrl = `https://aidoru-online.org/download.php?id=${torrentId}`;
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
    .then(result => {
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
