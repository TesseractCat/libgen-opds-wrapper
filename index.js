const fs = require('fs');

const axios = require('axios').default;
const jsdom = require('jsdom');
const { JSDOM } = jsdom;

const express = require('express');
const app = express();
const port = 3000;

const opdsEntryTemplate = `
<entry>
    <author><name>{AUTHOR}</name></author>
    <title>{TITLE}</title>
    <link rel="{REL}"
          href="{URL}"
          type="{TYPE}"/>
</entry>
`;

const opdsTemplate = fs.readFileSync('./static/opds.xml').toString();
const config = JSON.parse(fs.readFileSync('./config.json').toString());

function constructEntry(title, url, rel = "subsection", author = "") {
    var temp = opdsEntryTemplate;
    temp = temp.replace("{TITLE}", title);
    temp = temp.replace("{AUTHOR}", author);
    temp = temp.replace("{URL}", url);
    temp = temp.replace("{REL}", rel);

    if (rel == "search") {
        temp = temp.replace("{TYPE}", "application/opensearchdescription+xml");
    } else if (rel == "http://opds-spec.org/acquisition") {
        temp = temp.replace("{TYPE}", "application/epub+zip");
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

function searchResults(query, callback) {
    console.log(`Searching for ${query}`);
    let url = config.search + "?q=" + query + "&criteria=&language=English&format=epub";
    axios.get(url).then((response) => {
        let dom = new JSDOM(response.data);
        let links = Array.from(dom.window.document.querySelectorAll("a"))
            .filter((e) => e.href.match(/^\/fiction\/[A-Z0-9]{32}$/)).slice(0,10);

        console.log(`Found ${links.length} results`);

        let results = [];
        results.push({name: "—", url: "/"});
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

/* API */

app.get('/', (req, res) => {
    let entries = [];
    entries.push(constructEntry("Home", "/"));

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
    // Get download page
    axios.get(url).then((tempResponse) => {
        // Find URL
        let dom = new JSDOM(tempResponse.data);
        let links = dom.window.document.querySelectorAll("a");

        for (let i = 0; i < links.length; i++) {
            // Download from cloudflare-ipfs
            if (links[i].href.includes("cloudflare-ipfs")) {
                console.log(`Downloading URL ${links[i].href}`);
                // Download
                axios.get(links[i].href, {responseType: 'stream'}).then((downloadResponse) => {
                    downloadResponse.data.pipe(temp).on('close', () => {
                        console.log(`Done downloading!`);
                        res.sendFile(__dirname + '/temp.epub');
                    });
                });
                break;
            }
        }
    }, () => {
        // Can't download
        let entries = [];
        entries.push(constructEntry("No URL - back", "/"));

        res.set('Last-Modified', new Date().toUTCString());
        res.type('application/xml');
        res.send(constructPage("OPDS Search - Error", entries));
    });
});

app.get('/downloads', (req, res) => {
    let entries = [];
    entries.push(constructEntry("Home", "/"));
    entries.push(constructEntry("Refresh", "/downloads"));

    res.set('Last-Modified', new Date().toUTCString());
    res.type('application/xml');
    res.send(constructPage("OPDS Search - Downloads", entries));
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

        searchResults(search, (results) => {
            for (let i = 0; i < results.length; i++) {
                let result = results[i];
                entries.push(constructEntry(result.name, result.url, "http://opds-spec.org/acquisition", result.author));
            }

            res.send(constructPage("OPDS Search - Results", entries));
        });
    }
});

app.listen(port, () => {
    console.log(`OPDS app listening on port ${port}`);
    console.log(`Using search URL <${config.search}>, download URL <${config.download}>`);
});
