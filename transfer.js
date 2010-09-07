require.paths.push('/usr/lib/node')
// require.paths.push('./../node_debug/node_debug/debug.js')
var http = require("http");
var url = require("url");
var multipart = require("multipart");
var sys = require("sys");
var fs = require("fs");
var child_process = require("child_process");

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
		default:
			show_404(req, res);
			break;
	}
});

var debug = require("./node_debug/debug.js");
debug.listen(8080);

// Server would listen on port 8000
server.listen(8000);

/*
 * Display upload form
 */
function display_form(req, res) {
	res.writeHead(200, {"Content-Type": "text/html"});
	 child_process.exec("uuidgen", function(err, stdout, stderr) {
		var uuid = stdout.trim();
		uuids.push(uuid);
		 res.write(
			  '<form action="/upload?uuid=' + uuid + '" method="post" enctype="multipart/form-data">'+
			  '<input type="file" name="upload-file">'+
			  '<input type="submit" value="Upload">'+
			  '</form>'
		 );
		 res.close();
	});
}

function get_file(req, res) {
	var params = url.parse(req.url, true).query;
	var uuid = params.uuid;
	sys.debug('request for uuid = ' + uuid);
	if (typeof uploads[uuid] == 'undefined') {
		res.writeHead(404, 'Not Found');
		res.write('File not found.');
		res.end();
		return;
	}

	res.writeHead(200, 'OK', {
		'Content-type':  uploads[uuid].contentType,
		'Content-Disposition': 'attachment; filename="' + uploads[uuid].filename + '"',
		'Content-Transfer-Encoding': 'binary'
	});
	// write first chunk
	uploads[uuid].downloader = res;
	res.addListener('drain', function() {
		sys.debug('Downloader drained.  Resuming uploader.');
		uploads[uuid].uploader.resume();
	});
	sys.debug('Writing first chunk to client');
	if (uploads[uuid].chunk != null && res.write(uploads[uuid].chunk, 'binary')) {
		sys.debug('First chunk written with no waiting.  Resuming uploader.');
		uploads[uuid].uploader.resume();
	}
	if (uploads[uuid].uploadComplete) {
		sys.debug('Upload is already complete.  Completing download.')
		res.end();
	}
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

function Transfer() {
	this.uploader = this.downloader = null;
}

Transfer.prototype.transfer = function() {
	
}

/*
 * Handle file upload
 */
function upload_file(req, res) {
	// Request body is binary
	try {
		var params = url.parse(req.url, true).query;
		var uuid = params.uuid;
	} catch (e) {
		sys.debug(e);
		show_error(e, req, res);
	}
	sys.debug('uuid = ' + uuid);
	req.setEncoding("binary");
	uploads[uuid] = {};
	uploads[uuid].uploadComplete = false;

	for (var i in req) {
		if (req.hasOwnProperty(i)) {
			sys.debug('req.' + i + '= ' + req[i]);
		}
	}

	// Handle request as multipart
	var stream = parse_multipart(req);

	var fileName = null;
	var fileStream = null;

	// Set handler for a request part received
	stream.onPartBegin = function(part) {
		sys.debug("Started part, name = " + part.name + ", filename = " + part.filename);

		uploads[uuid].filename = part.filename;
		uploads[uuid].uploader = req;
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
		uploads[uuid].contentType = part.headers['content-type'];
		req.pause();
	};

	// Set handler for a request part body chunk received
	stream.onData = function(chunk) {
		sys.debug('Got multipart chunk');
		// Pause receiving request data (until current chunk is written)
		req.pause();
		/*
		setTimeout(function() {
			req.resume();
		}, 3000);
		*/

		// Write chunk to file
		// Note that it is important to write in binary mode
		// Otherwise UTF-8 characters are interpreted
		// sys.debug("Writing chunk");
		// fileStream.write(chunk, "binary");

		if (uploads[uuid].downloader) {
			sys.debug('Found a downloader.  Writing chunk.');
			if (uploads[uuid].downloader.write(chunk, 'binary')) {
				// write to client flushed to kernel buffer
				sys.debug('No wait sending chunk to downloader.  Resuming uploader.');
				req.resume();
			}
		} else {
			sys.debug('No downloader.  Storing chunk.');
			uploads[uuid].chunk = chunk;
		}
	};

	// Set handler for request completed
	stream.onEnd = function() {
		sys.debug('stream ended');
		// As this is after request completed, all writes should have been queued by now
		// So following callback will be executed after all the data is written out
		if (uploads[uuid].downloader) {
			// downloader is done
			sys.debug('Download complete');
			uploads[uuid].downloader.end();
			// Handle request completion, as all chunks were already written
			upload_complete(res);
		} else {
			uploads[uuid].uploadComplete = true;
			upload_complete(res);
		}
		delete uploads[uuid];
	};
}

function upload_complete(res) {
	sys.debug("Upload request complete");

	// Render response
	res.writeHead(200, {
		'Content-Type': 'text/plain',
	});
	res.write("Thanks for playing!");
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
	res.writeHead(404, {"Content-Type": "text/plain"});
	res.write(err);
	res.end();
}
