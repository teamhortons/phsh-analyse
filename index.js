require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const axios = require("axios");

const app = express();
const port = process.env.PORT || 5000;

app.listen(port, () => console.log(`Server started on port: ${port}`));

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(
	bodyParser.urlencoded({
		limit: "50mb",
		extended: true
	})
);

app.get("/health", (req, res) => {
	res.sendStatus(200);
});

app.post("/report", async (req, res) => {
	console.log(req.body);
	const { requestedDomain } = req.body;
	const domainInHex = convertStringToHex(requestedDomain);
	const fuzzData = await fuzzAllPossibleDomains(domainInHex);

	const fuzzDomains = fuzzData.fuzzy_domains;
	const fuzzReport = fuzzDomains.map(async fuzzy => {
		const { domain, fuzzer } = fuzzy;
		const parkedPossibility = await determineParkedPossibilities(fuzzy);
		const result = { ...parkedPossibility, domain, fuzzer };
		return result;
	});

	res.send({ report: fuzzReport });
});

app.post("/alike", (req, res) => {
	console.log(req.body);
	const { url, image } = req.body;
	// check
	res.sendStatus({});
});

fuzzAllPossibleDomains = domain => {
	return new Promise((resolve, reject) => {
		axios(`https://dnstwister.report/api/fuzz/${domain}`)
			.then(result => result.data)
			.then(result => resolve(result));
	});
};

resolveIpToUrl = ip => {
	return new Promise((resolve, reject) => {
		axios(ip)
			.then(result => result.data)
			.then(result => {
				if (result.error) reject();
				resolve(result.ip);
			});
	});
};

determineParkedPossibilities = data => {
	return new Promise((resolve, reject) => {
		axios(data.parked_score_url)
			.then(result => result.data)
			.then(async result => {
				// prettier-ignore
				const { resolve_ip_url, dressed, redirects, redirects_to, score, score_text} = result;
				const ip = await resolveIpToUrl(resolve_ip_url);
				// prettier-ignore
				resolve({ dressed, redirects, redirects_to, score, score_text, ip});
			});
	});
};

convertStringToHex = domain => {
	let result = [];
	[...domain].map((char, index) => {
		const hex = domain.charCodeAt(index).toString(16);
		result.push(hex);
	});

	return result.join("");
};

(async () => {})();
