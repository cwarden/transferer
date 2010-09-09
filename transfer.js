// Debian puts libraries in /usr/lib/nodejs, but npm (not yet packaged) uses /usr/lib/node
require.paths.push('/usr/lib/node')
var http = require("http");
var url = require("url");
var multipart = require("multipart");
var sys = require("sys");
var fs = require("fs");
var child_process = require("child_process");
var parrot = require('./lib/parrot');

var uploads = {};
var uuids = [];

var server = http.createServer(function(req, res) {
	// Simple path-based request dispatcher
	switch (url.parse(req.url).pathname) {
		case '/':
			display_form(req, res);
			break;
		case '/upload':
			upload_file(req, res);
			break;
		case '/get':
			get_file(req, res);
			break;
		case '/watch':
			watch(req, res);
			break;
		default:
			show_404(req, res);
			break;
	}
});

server.listen(8000);

/*
 * Display upload form
 */
function display_form(req, res) {
	res.writeHead(200, {"Content-Type": "text/html"});
	 child_process.exec("uuidgen", function(err, stdout, stderr) {
		var uuid = stdout.trim();
		uuids.push(uuid);

		fs.readFile('./templates/form.tmpl',
			function(err, data) {
				if (err) {
					throw err;
				}
				var output = parrot.render(data, {
					sandbox: {
						uuid: uuid
					}
				});
				res.write(output);
				res.end();
			 }
		);
	});
}


/*
 * Create multipart parser to parse given request
 */
function parse_multipart(req) {
	var parser = multipart.parser();

	// Make parser use parsed request headers
	parser.headers = req.headers;

	// Add listeners to request, transfering data to parser

	req.addListener("data", function(chunk) {
		parser.write(chunk);
	});

	req.addListener("end", function() {
		parser.close();
	});

	return parser;
}

// get Transporter object used by both uploader and downlaoder
var getTransporter = (function() {
	// hash of transporters in use
	var transporters = {};

	function Transporter(uuid) {
		if (!(this instanceof arguments.callee)) {
			throw new Error('Constructor called as function');
		}
		this.uuid = uuid;
		this.uploader = this.downloader = null;
		this.watchers = [];
		this.transfered = 0;
	}

	// send a chunk to the downloader.  if there is no downloader yet, wait for him.
	Transporter.prototype.upload = function(chunk) {
		this.uploader.req.pause();
		this.transfered += chunk.length;

		var status = {};
		status.bytes = this.transfered;
		status.downloading = false;
		if (this.downloader) {
			sys.debug('Found a downloader.  Writing chunk.');
			if (this.downloader.res.write(chunk, 'binary')) {
				// write to client flushed to kernel buffer
				sys.debug('No wait sending chunk to downloader.  Resuming uploader.');
				this.uploader.req.resume();
			}
			status.downloading = true;
		} else {
			sys.debug('No downloader.  Storing chunk.');
			this.chunk = chunk;
		}

		var msg = JSON.stringify(status);
		var w;
		while (w = this.watchers.shift()) {
			w.res.end(msg);
		}
	};

	// start download
	Transporter.prototype.download = function(req, res) {
		this.downloader = {
			'req': req,
			'res': res
		};

		this.downloader.res.writeHead(200, 'OK', {
			'Content-type':  this.contentType,
			'Content-Disposition': 'attachment; filename="' + this.filename + '"',
			// 'Content-Transfer-Encoding': 'binary'
		});

		// assumes uploader starts first
		var uploader = this.uploader;
		this.downloader.res.addListener('drain', function() {
			sys.debug('Downloader drained.  Resuming uploader.');
			uploader.req.resume();
		});

		sys.debug('Writing first chunk to client');
		if (this.chunk != null && this.downloader.res.write(this.chunk, 'binary')) {
			sys.debug('First chunk written with no waiting.  Resuming uploader.');
			this.uploader.req.resume();
		}
		if (this.uploadComplete) {
			sys.debug('Upload is already complete.  Completing download.')
			this.downloader.res.end();
		}
	};

	Transporter.prototype.watch = function(req, res) {
		res.writeHead(200, {"Content-Type": "application/x-javascript"});
		if (this.downloadComplete) {
			var status = {
				bytes: this.transfered,
				complete: true
			}
			var msg = JSON.stringify(status);
			res.end(msg);
			return;
		}

		this.watchers.push({
			'req': req,
			'res': res
		});
	};

	Transporter.prototype.shutdown = function() {
		if (this.downloader) {
			// downloader is done
			sys.debug('Download complete');
			this.downloadComplete = true;
			this.downloader.res.end();
			// Handle request completion, as all chunks were already written
			upload_complete(this.uploader.res);
		} else {
			sys.debug('Upload complete');
			this.uploadComplete = true;
			upload_complete(this.uploader.res, true);
		}
		for (var i = 0; i < this.watchers.length; i++) {
			this.watchers[i].res.end();
		}
		sys.debug('Destroying Transporter for uuid: ' + this.uuid);
		sys.debug('Transfered ' + this.transfered + ' bytes');
		// delete transporters[this.uuid];
		this.uploader = this.downloader = null;
		this.watchers = [];
	};

	return function(uuid) {
		if (typeof transporters[uuid] == 'undefined') {
			transporters[uuid] = new Transporter(uuid);
		}
		sys.debug('TRANSPORTERS: ');
		for (var i in transporters) {
			if (transporters.hasOwnProperty(i)) {
				sys.debug(i);
			}
		}
		return transporters[uuid];
	};
})();

// download file
function get_file(req, res) {
	var params = url.parse(req.url, true).query;
	var uuid = params.uuid.replace(/[^\w-]/g, '');
	sys.debug('request for uuid = ' + uuid);
	var transporter = getTransporter(uuid);
	
	// downloader-initiated transfers not implemented yet
	if (!transporter.uploader) {
		res.writeHead(404, 'Not Found');
		res.write('File not found.  Was the uploaded started first?');
		res.end();
		return;
	}

	transporter.download(req, res);
}

function watch(req, res) {
	var params = url.parse(req.url, true).query;
	var uuid = params.uuid.replace(/[^\w-]/g, '');
	sys.debug('watch request for uuid = ' + uuid);
	var transporter = getTransporter(uuid);

	transporter.watch(req, res);
}


/*
 * Handle file upload
 */
function upload_file(req, res) {
	try {
		var params = url.parse(req.url, true).query;
		var uuid = params.uuid.replace(/[^\w-]/g, '');
	} catch (e) {
		sys.debug(e);
		show_error(e, req, res);
	}
	sys.debug('uuid = ' + uuid);
	req.setEncoding("binary");

	/*
	for (var i in req) {
		if (req.hasOwnProperty(i)) {
			sys.debug('req.' + i + '= ' + req[i]);
		}
	}
	*/

	var transporter = getTransporter(uuid);
	sys.debug('TRANSPORTER: ' + transporter);
	transporter.uploader = {
		'req': req,
		'res': res
	};

	// Handle request as multipart
	var stream = parse_multipart(req);

	// Set handler for a request part received
	stream.onPartBegin = function(part) {
		sys.debug("Started part, name = " + part.name + ", filename = " + part.filename);

		/*
		for (var i in part) {
			if (part.hasOwnProperty(i)) {
				sys.debug('part.' + i + ' = ' + part[i]);
			}
		}
		for (i in part.headers) {
			if (part.headers.hasOwnProperty(i)) {
				sys.debug('part.headers.' + i + ' = ' + part.headers[i]);
			}
		}
		*/

		transporter.filename = part.filename;
		transporter.contentType = part.headers['content-type'];
	};

	// Set handler for a request part body chunk received
	stream.onData = function(chunk) {
		sys.debug('Got multipart chunk');
		transporter.upload(chunk);
	};

	// Set handler for request completed
	stream.onEnd = function() {
		sys.debug('stream ended');
		transporter.shutdown();
	};
}

function upload_complete(res, noDownload) {
	sys.debug("Upload request complete");

	// Render response
	res.writeHead(200, {
		'Content-Type': 'text/plain',
	});
	if (noDownload) {
		res.write("That was a little one.  Why not just email it?");
	} else {
		res.write("File transfer complete!");
	}
	res.end();

	sys.puts("\n=> Done");
}

/*
 * Handles page not found error
 */
function show_404(req, res) {
	res.writeHead(404, {"Content-Type": "text/plain"});
	res.write("No such file");
	res.end();
}

function show_error(err, req, res) {
	res.writeHead(500, {"Content-Type": "text/plain"});
	res.write(err.name + "\n" + err.message);
	res.end();
}
