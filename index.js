const fs = require('fs');

const FormData = require('form-data');
const axios = require('axios').default;
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const express = require('express');
const app = express();

const opdsEntryTemplate = `
<entry>
    <author><name>{AUTHOR}</name></author>
    <title>{TITLE}</title>
    <link rel="{REL}"
          href="{URL}"
          type="{TYPE}"
          pse:count="{COUNT}" />
</entry>
`;

const seperator = "⸻";
const opdsTemplate = fs.readFileSync('./static/opds.xml').toString();
const config = JSON.parse(fs.readFileSync('./config.json').toString());

const port = config.port;
const tachideskPort = config.tachideskPort;

function constructEntry(title, url, rel = "subsection", author = "", count = 1) {
    var temp = opdsEntryTemplate;
    temp = temp.replace("{TITLE}", title);
    temp = temp.replace("{AUTHOR}", author);
    temp = temp.replace("{URL}", url);
    temp = temp.replace("{REL}", rel);
    temp = temp.replace("{COUNT}", count);

    if (rel == "search") {
        temp = temp.replace("{TYPE}", "application/opensearchdescription+xml");
    } else if (rel == "http://opds-spec.org/acquisition") {
        temp = temp.replace("{TYPE}", "application/epub+zip");
    } else if (rel == "http://vaemendis.net/opds-pse/stream") {
        temp = temp.replace("{TYPE}", "image/jpeg");
    } else {
        temp = temp.replace("{TYPE}", "application/atom+xml;profile=opds-catalog;kind=acquisition");
    }
    return temp;
}
function constructPage(title, entries, showSearch = false) {
    xml = opdsTemplate.replace("{ENTRIES}", entries.join('\n'));
    xml = xml.replace("{TITLE}", title);
    xml = xml.replace("{SEARCH}", showSearch ?
        '<link rel="search" type="application/opensearchdescription+xml" title="Search" href="/search"/>'
        : '');
    return xml;
}

function libgenSearch(query, callback) {
    console.log(`Searching for ${query}`);
    let url = config.search + "?q=" + query + "&criteria=&language=English&format=epub";
    axios.get(url).then((response) => {
        let dom = new JSDOM(response.data);
        let links = Array.from(dom.window.document.querySelectorAll("a"))
            .filter((e) => e.href.match(/^\/fiction\/[A-Z0-9]{32}$/)).slice(0,10);

        console.log(`Found ${links.length} results`);

        let results = [];
        results.push({name: seperator, url: "/"});
        for (let i = 0; i < links.length; i++) {
            let md5 = links[i].href.replace('/fiction/','');
            let author = links[i].parentElement.parentElement.firstElementChild.textContent;
            author = author.replace(/[^A-z0-9 ,\-]/g,'');
            results.push({
                name: links[i].textContent,
                author: author,
                url: '/download?book=' + md5
            });
        }
        callback(results);
    });
}
function libgenDownload(url, callback) {
    axios.get(url).then((tempResponse) => {
        // Find URL
        let dom = new JSDOM(tempResponse.data);
        let links = dom.window.document.querySelectorAll("a");

        for (let i = 0; i < links.length; i++) {
            // Download from cloudflare-ipfs
            if (links[i].href.includes("cloudflare-ipfs")) {
                callback(links[i].href);
                return;
            }
        }
    }, () => {
        callback(null);
        return;
    });
}

/* API */

app.get('/', (req, res) => {
    let entries = [];
    entries.push(constructEntry("Home", "/"));
    entries.push(constructEntry("Manga", "/manga"));

    res.set('Last-Modified', new Date().toUTCString());
    res.type('application/xml');
    res.send(constructPage("OPDS Search - Home", entries, true));
});

app.get('/download', (req, res) => {
    let book = req.query.book;
    let url = config.download + book;

    // Can download
    console.log(`Visiting page ${url}`);

    const temp = fs.createWriteStream('./temp.epub');
    libgenDownload(url, (fileUrl) => {
        if (fileUrl == null) {
            // Can't download
            let entries = [];
            entries.push(constructEntry("No URL - back", "/"));

            res.set('Last-Modified', new Date().toUTCString());
            res.type('application/xml');
            res.send(constructPage("OPDS Search - Error", entries));
        } else {
            console.log(`Downloading URL ${fileUrl}`);
            // Download
            axios.get(fileUrl, {responseType: 'stream'}).then((downloadResponse) => {
                downloadResponse.data.pipe(temp).on('close', () => {
                    console.log(`Done downloading!`);
                    res.sendFile(__dirname + '/temp.epub');
                });
            });
        }
    });
});

app.get('/manga', (req, res) => {
    let entries = [];
    entries.push(constructEntry("Home", "/"));
    entries.push(constructEntry(seperator, "/"));

    axios.get(`http://localhost:${tachideskPort}/api/v1/category/0`).then((json) => {
        json.data.forEach((manga) => {
            entries.push(constructEntry(manga.title, "/chapters?id=" + manga.id.toString()));
        });

        res.set('Last-Modified', new Date().toUTCString());
        res.type('application/xml');
        res.send(constructPage("OPDS Search - Manga", entries));
    });
});

app.get('/chapters', (req, res) => {
    let manga = req.query.id;

    let entries = [];
    entries.push(constructEntry("Home", "/"));
    entries.push(constructEntry("Back", "/manga"));
    entries.push(constructEntry("Refresh", `/chapters?id=${manga}`));
    entries.push(constructEntry(seperator, "/"));

    axios.get(`http://localhost:${tachideskPort}/api/v1/manga/${manga}/chapters`).then((json) => {
        let sortedChapters = [...json.data].filter(a => a.read).sort((a, b) => b.lastReadAt - a.lastReadAt);
        let nextChapterIdx = sortedChapters.length > 0 ?
            sortedChapters[0].index + 1 : json.data[json.data.length - 1].index;
        let nextChapter = [...json.data].filter(a => a.index == nextChapterIdx)[0];

        if (nextChapter != undefined) {
            entries.push(constructEntry(
                "Next: " + nextChapter.name,
                `/page?id=${manga}&amp;chapter=${nextChapter.index}&amp;page={pageNumber}&amp;width={maxWidth}`,
                "http://vaemendis.net/opds-pse/stream", "",
                parseInt(nextChapter.pageCount) == -1 ? 99 : parseInt(nextChapter.pageCount)
            ));

            entries.push(constructEntry(seperator, "/"));
        }

        json.data.forEach((chapter) => {
            let pageCount = parseInt(chapter.pageCount);
            if (pageCount == -1)
                pageCount = 99;
            entries.push(constructEntry(
                chapter.name + " | " + new Date(chapter.uploadDate).toUTCString().slice(5,16),
                `/page?id=${manga}&amp;chapter=${chapter.index}&amp;page={pageNumber}&amp;width={maxWidth}`,
                "http://vaemendis.net/opds-pse/stream", "",
                parseInt(pageCount)
            ));
        });

        res.set('Last-Modified', new Date().toUTCString());
        res.type('application/xml');
        res.send(constructPage("OPDS Search - Manga", entries));
    });
});

app.get('/search', (req, res) => {
    res.set('Last-Modified', new Date().toUTCString());
    res.type('application/xml');

    let search = req.query.q;
    if (search == null) {
        let description = fs.readFileSync('./static/description.xml').toString();

        res.send(description);
    } else {
        let entries = [];
        entries.push(constructEntry("Home", "/"));

        libgenSearch(search, (results) => {
            for (let i = 0; i < results.length; i++) {
                let result = results[i];
                entries.push(constructEntry(result.name, result.url, "http://opds-spec.org/acquisition", result.author));
            }

            res.send(constructPage("OPDS Search - Results", entries));
        });
    }
});

app.get('/page', (req, res) => {
    let manga = req.query.id;
    let chapter = req.query.chapter;
    let page = parseInt(req.query.page);

    axios.get(`http://localhost:${tachideskPort}/api/v1/manga/${manga}/chapter/${chapter}`).then((json) => {
        let pageCount = json.data.pageCount;
        let formData = new FormData();
        formData.append('lastPageRead', page.toString());

        if (page >= pageCount) {
            res.sendStatus(404);
            return;
        } else if (page == pageCount - 1) {
            formData.append('read', 'true');
            axios.patch(`http://localhost:${tachideskPort}/api/v1/manga/${manga}/chapter/${chapter}`,
                formData, {headers: formData.getHeaders()});
        } else {
            axios.patch(`http://localhost:${tachideskPort}/api/v1/manga/${manga}/chapter/${chapter}`,
                formData, {headers: formData.getHeaders()});
        }

        axios.get(`http://localhost:${tachideskPort}/api/v1/manga/${manga}/chapter/${chapter}/page/${page}`,
            {responseType: 'arraybuffer'})
            .then((image) => {
            res.set('Last-Modified', new Date().toUTCString());
            res.type('image/jpeg');
            res.send(image.data);
        });
    });
});

app.listen(port, () => {
    console.log(`OPDS app listening on port ${port}`);
    console.log(`Using search URL <${config.search}>, download URL <${config.download}>`);
});
