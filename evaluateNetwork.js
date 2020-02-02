var common = require("./common");
var convnetjs = require("convnetjs");

function usage() {
	console.log(`${process.argv[0]} ${process.argv[1]} --net NETWORK.JSON --slicesize SLICE_SIZE --step 1 --img FILENAME [--x Xoffset --y Yoffset]`);
}

function sliceImgVol(imageVolume, slicesize, xystep, cb) {
	for (var x = 0; x <= imageVolume.sx - slicesize; x += xystep) {
		for (var y = 0; y <= imageVolume.sy - slicesize; y += xystep) {
			cb(x, y, convnetjs.augment(imageVolume, slicesize, x, y));
		}
	}
}

function processVolume(cropImgVol, x, y) {
	var activations = net.forward(cropImgVol);
	var topIdx = net.getPrediction();
	var topLabel = labels[topIdx];
	var topConfidence = activations.w[topIdx];

	var top = common.evaluate_activation(activations, labels);

	console.log(`(${x},${y}): ${topIdx} ${topLabel} = ${top.confidence.toFixed(3)}`);
}

var argv = require("minimist")(process.argv.slice(2));

if (!("net" in argv)) {
	console.log("Network not defined");
	usage();
	process.exit(1);
}

if (!("slicesize" in argv)) {
	console.log("Slicesize not defined");
	usage();
	process.exit(1);
}
if (!("step" in argv)) {
	console.log("Step not defined");
	usage();
	process.exit(1);
}
if (!("img" in argv)) {
	console.log("Image not defined");
	usage();
	process.exit(1);
}

var xOffset = -1;
var yOffset = -1;
if ("x" in argv && "y" in argv) {
	xOffset = argv.x;
	yOffset = argv.y;
}

var net = common.load_network(argv.net);

if (net === "undefined") {
	console.log("Error encountered while loading network!");
	process.exit(1);
}

var labels = common.get_all_labels();
var imageVolume = common.create_volume_for_image_path(argv.img);

if (xOffset == -1 && yOffset == -1) {
	sliceImgVol(imageVolume, argv.slicesize, argv.step, processVolume);
} else {
	var cropVol = convnetjs.augment(imageVolume, argv.slicesize, xOffset, yOffset);
	processVolume(cropVol, xOffset, yOffset);
}
