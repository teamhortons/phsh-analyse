require("dotenv").config();

const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
const port = process.env.PORT || 5000;

app.listen(port, () => {
	console.log(`Server started on port: ${port}`);
});

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(
	bodyParser.urlencoded({
		limit: "50mb",
		extended: true
	})
);

(async () => {})();

app.post("/alike", (req, res) => {
	console.log(req.body);
	res.sendStatus(200);
});
