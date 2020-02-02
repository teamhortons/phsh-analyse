"esversion: 6";
"use strict";

let fs = require("fs");
let http = require("http");

let convnetjs = require("convnetjs");
let common = require("./common");
let cnnutil = require("./cnnutil");

//engine constants.
const SLICE_SIZE = 96;
const MAX_NEGATIVE_RATIO = 0.3;
const INCREASE_NEGATIVE_TRAINING_THRESHOLD = 0.8;
const TARGET_ACCURACY = 0.95;

//statistical monitoring.
let xLossWindow = new cnnutil.Window(100);
let wLossWindow = new cnnutil.Window(100);
let trainAccWindow = new cnnutil.Window(100);
let trainAccValidWindow = new cnnutil.Window(100);

let step_num = 0;
let negative_ratio = 0.15;

let net = null;
let trainer = null;
let last_stats = null;

//performs a roulette selection based on array of weights (`inputs`) and returns the chosen index.
function roulette_selection(inputs) {
	//sum all weights.
	let input_sum = 0.0;
	for (let i = 0; i < inputs.length; i++) {
		input_sum += inputs[i];
	}

	//normalize to 0..1;
	let normalized_input = new Array(inputs.length);
	for (let i = 0; i < inputs.length; i++) {
		normalized_input[i] = inputs[i] / input_sum;
	}

	//perform roulette selection.
	let target = Math.random();
	for (let i = 0; i < inputs.length; i++) {
		target -= normalized_input[i];

		if (target <= Number.EPSILON) {
			return i;
		}
	}
	assert(false); //shouldn't ever get here.
}

//Randomly picks a super-sample from the training set.
function fair_sampler() {
	return samples[Math.floor(Math.random() * samples.length)];
}

//Randomly (and inefficiently) picks a super-sample for a given label, `labelid`.
function sampler_for_label(labelid) {
	let sample = null;
	do {
		sample = fair_sampler();
	} while (sample.label !== labelid);

	return sample;
}

//Randomly (and inefficiently) picks a positive super-sample.
function sampler_positive_only() {
	let sample = null;
	do {
		sample = fair_sampler();
	} while (sample.label == common.negative_labelid);

	return sample;
}

//Performs roulette selection for positive super-samples based on current network accuracy.
function sampler_positive_roulette() {
	let curr_accs = [];
	let labelids = [];

	for (let labelid in common.label_accuracies) {
		labelid = Number(labelid);

		if (labelid === common.negative_labelid) {
			continue;
		}

		let label_acc = common.label_accuracies[labelid];
		let acc = label_acc.window.get_average();

		//clamp weird values during start up
		if (acc > 1.0) acc = 1.0;
		if (acc < 0.0) acc = 0;

		curr_accs.push(1.0 - acc); // we want the lowest performers so 1 - current accuracy.
		labelids.push(labelid);
	}
	let roulette_result = roulette_selection(curr_accs);
	let target_label = labelids[roulette_result];
	return sampler_for_label(target_label);
}

//Retrieves a super-sample for training the network based on lowest performance.
function sampler_training() {
	let want_positive = Math.random() >= negative_ratio;
	if (want_positive) {
		let should_roulette = Math.random() > 0.5;
		if (should_roulette) {
			return sampler_positive_roulette();
		}
		return sampler_positive_only();
	}
	return sampler_for_label(common.negative_labelid);
}

//Creates a new neural network instance.
function create_network() {
	let labels = common.get_all_labels();
	let layer_defs = [];
	layer_defs.push({
		type: "input",
		out_sx: SLICE_SIZE,
		out_sy: SLICE_SIZE,
		out_depth: 3
	});
	layer_defs.push({
		type: "conv",
		sx: 5,
		filters: 18,
		stride: 1,
		pad: 2,
		activation: "relu"
	});
	layer_defs.push({ type: "pool", sx: 4, stride: 2 });
	layer_defs.push({
		type: "conv",
		sx: 5,
		filters: 20,
		stride: 1,
		pad: 2,
		activation: "relu"
	});
	layer_defs.push({ type: "pool", sx: 4, stride: 2 });
	layer_defs.push({
		type: "conv",
		sx: 5,
		filters: 20,
		stride: 1,
		pad: 2,
		activation: "relu"
	});
	layer_defs.push({ type: "pool", sx: 4, stride: 2 });

	layer_defs.push({ type: "softmax", num_classes: labels.length });

	let net = new convnetjs.Net();
	net.makeLayers(layer_defs);

	return net;
}

//Performs validation testing and updates current network accuracies.
function validate() {
	let total_iters = 100;
	for (let i = 0; i < total_iters; i++) {
		let sample =
			i < total_iters - total_iters * negative_ratio
				? sampler_positive_only()
				: sampler_for_label(common.negative_labelid);

		trainer.net.forward(convnetjs.augment(sample.data, SLICE_SIZE));

		//if the network evaluated correctly, full points (1.0) if it comes back as negative then 0.25 points.
		common.update_label_accuracy(
			sample.label,
			sample.label === trainer.net.getPrediction()
				? 1.0
				: sample.label === common.negative_labelid
				? 0.25
				: 0
		);
	}
}

//Training step.
function step(sample) {
	//take super-sample and carve a random volume SLICE_SIZE * SLICE_SIZE volume out of it.
	//If the sample is a member of the 'negative' label, further attempt to augment it.
	let offset_x = Math.floor(Math.random() * (sample.data.sx - SLICE_SIZE));
	let offset_y = Math.floor(Math.random() * (sample.data.sy - SLICE_SIZE));
	let sampleVol = convnetjs.augment(
		sample.data,
		SLICE_SIZE,
		offset_x,
		offset_y,
		sample.label === common.negative_labelid && Math.random() > 0.5
	); // take a random SLICE_SIZE x SLICE_SIZE crop.
	let sampleTruth = sample.label;

	// train on it with network
	last_stats = trainer.train(sampleVol, sampleTruth);
	let lossx = last_stats.cost_loss;
	let lossw = last_stats.l2_decay_loss;

	// keep track of stats such as the average training error and loss
	let netPred = net.getPrediction();
	let train_acc =
		netPred === sampleTruth
			? 1.0
			: netPred === common.negative_labelid
			? 0.25
			: 0.0;

	xLossWindow.add(lossx);
	wLossWindow.add(lossw);
	trainAccWindow.add(train_acc);

	if (sampleTruth !== common.negative_labelid) {
		trainAccValidWindow.add(train_acc);
	}

	return true;
}

//Main training loop.
function tick() {
	//get sample
	let sample = sampler_training();
	//train network
	if (step(sample)) {
		step_num++;

		//Update validation accuracy every 100 training steps.
		if (step_num % 100 === 0) {
			console.log("\nPerforming validation pass...");
			validate();

			let t =
				"Validation accuracy: G=" +
				common.get_current_accuracy(false).toFixed(3) +
				" V=" +
				common.get_current_accuracy(true).toFixed(3);
			t +=
				"\nTraining accuracy: G=" +
				cnnutil.f2t(trainAccWindow.get_average()) +
				" V=" +
				cnnutil.f2t(trainAccValidWindow.get_average());
			t += "\nForward time per sample: " + last_stats.fwd_time + "ms";
			t += "\nBackprop time per sample: " + last_stats.bwd_time + "ms";
			t += "\nClassification loss: " + cnnutil.f2t(xLossWindow.get_average());
			t += "\nL2 Weight decay loss: " + cnnutil.f2t(wLossWindow.get_average());
			t += "\nNegative sample ratio: " + negative_ratio.toFixed(2);
			t += "\nSamples seen: " + step_num;

			t += "\n\nCurrent label accuracy:";

			for (let labelid in common.label_accuracies) {
				let label_acc = common.label_accuracies[labelid];
				t +=
					"\n" +
					("           " + label_acc.label).slice(-11) +
					" " +
					label_acc.window.get_average().toFixed(2);
			}
			console.log(t);

			//Serialize the network to disk every 1000 steps and check for termination condition.
			if (step_num && step_num % 1000 === 0) {
				let net_json = trainer.net.toJSON();
				let serial_net = {
					labels: common.label_configs,
					network: net_json,
					negative_ratio: negative_ratio
				};
				fs.writeFileSync("network.json", JSON.stringify(serial_net));

				//Are we done training?
				if (common.get_current_accuracy(true) > TARGET_ACCURACY) {
					return false;
				}
			}

			//Over time/training progress increase the ratio of negative samples included by the sampler.
			if (
				step_num != 0 &&
				step_num % 100 == 0 &&
				((trainAccValidWindow.get_average() >
					INCREASE_NEGATIVE_TRAINING_THRESHOLD &&
					common.get_current_accuracy(true) >
						INCREASE_NEGATIVE_TRAINING_THRESHOLD) ||
					step_num % 3000 == 0) &&
				negative_ratio < MAX_NEGATIVE_RATIO
			) {
				negative_ratio += 0.05;
			}
		}
	}
	//Keep iterating.
	return true;
}

console.log("Initializing sample labels.");
common.init_labels();
console.log(
	"\nSample classes identified: " + JSON.stringify(common.get_all_labels())
);
console.log("Loading all samples...");
let samples = common.load_all_samples();

console.log("Done! Loaded " + samples.length + " samples.");

if (process.argv.length === 3) {
	net = common.load_network(process.argv[2]);
	if ("negative_ratio" in net) {
		negative_ratio = net.negative_ratio;
	}
	console.log("Loaded existing network " + process.argv[2]);
} else {
	console.log("Created new network.");
	net = create_network();
}

trainer = new convnetjs.Trainer(net, {
	method: "adadelta",
	batch_size: 5,
	l2_decay: 0.0001
});

console.log("Starting training. This will take a while...");
while (tick());
console.log("Training complete!");
