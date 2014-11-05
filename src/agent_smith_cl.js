if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
	AgentSmith = require('./agent_smith');
}

if (typeof AgentSmith === 'undefined' || typeof AgentSmith.Matrix === 'undefined') {
	throw new Error('AgentSmith.Matrix is not loaded');
}

(function() {
	var nodejs = (typeof window === 'undefined');
	if (nodejs) {
		var node_webcl_root = '../../node_modules/node-webcl'; // depends on the environment
		try {
			WebCL = require(node_webcl_root + '/webcl');
		} catch (e) {
			WebCL = void 0;
		}
	} else {
		WebCL = window.webcl;
	}
	
	if (WebCL === void 0) {
		console.error('WebCL is not supported in this environment');
		return;
	}

	var $M = AgentSmith.Matrix;
	$M.CL = {};
	var $CL = $M.CL;
	var $P = $M.prototype;
	
	// Prepare WebCL
	(function () {
		var platformList = WebCL.getPlatforms();
		$CL.platform = platformList[0];
		$CL.platform_info = $CL.platform.getInfo(WebCL.PLATFORM_NAME);
		$CL.devices = $CL.platform.getDevices(WebCL.DEVICE_TYPE_DEFAULT);
		$CL.device_info = $CL.devices[0].getInfo(WebCL.DEVICE_NAME);
		
		if (nodejs) {
			$CL.context = WebCL.createContext({
				deviceType : WebCL.DEVICE_TYPE_DEFAULT,
				platform : $CL.platform
			});
			$CL.kernelSetArg = function(kernel, idx, param, type) {
				kernel.setArg(idx, param, type);
			};
		} else {
			$CL.context = WebCL.createContext();
			WebCL.type = {
				CHAR: 0,
				UCHAR: 1,
				SHORT: 2,
				USHORT: 3,
				INT: 4,
				UINT: 5,
				LONG: 6,
				ULONG: 7,
				FLOAT: 8,
				HALF: 9,
				DOUBLE: 10,
				QUAD: 11,
				LONG_LONG: 12,
				VEC2: 65536,
				VEC3: 131072,
				VEC4: 262144,
				VEC8: 524288,
				VEC16: 1048576,
				LOCAL_MEMORY_SIZE: 255
			};
			$CL.kernelSetArg = function(kernel, idx, param, type) {
				if (type !== void 0) {
					switch (type) {
						case WebCL.type.UINT:
							param = new Uint32Array([param]);
							break;
						case WebCL.type.INT:
							param = new Int32Array([param]);
							break;
						case WebCL.type.FLOAT:
							param = new Float32Array([param]);
							break;
					}
				}
				kernel.setArg(idx, param);
			};
		}
		
		$CL.createKernel = function(name, code) {
			var program = $CL.context.createProgram(code);
			program.build($CL.devices);
			return program.createKernel(name);
		};
		
		$CL.executeKernel = function() {
			var localWS = [12];
			var queue = $CL.context.createCommandQueue($CL.devices[0], 0);
			
			return function(kernel, params, parallelization) {
				var buffers = [];
				var buffers_to_read_back = [];
				for (var i = 0; i < params.length; i++) {
					if (params[i].type === void 0) {
						// matrix
						var buffer = $CL.context.createBuffer(params[i].access, params[i].datum.byte_length);
						$CL.kernelSetArg(kernel, i, buffer);
						if (params[i].access !== WebCL.MEM_WRITE_ONLY) {
							queue.enqueueWriteBuffer(buffer, false, 0, params[i].datum.byte_length, params[i].datum.data);
						}
						buffers[i] = buffer;
						if (params[i].access === WebCL.MEM_WRITE_ONLY || params[i].access === WebCL.MEM_READ_WRITE) {
							buffers_to_read_back[i] = true;
						}
					} else {
						// native type
						$CL.kernelSetArg(kernel, i, params[i].datum, params[i].type);
					}
				};

				var globalWS = [Math.ceil(parallelization / localWS) * localWS];
	
				// Execute kernel
				if (nodejs) {
					queue.enqueueNDRangeKernel(kernel, null, globalWS, localWS);
				} else {
					queue.enqueueNDRangeKernel(kernel, globalWS.length, null, globalWS, localWS);
				}
	
				// Read back from buffers
				for (var i = 0; i < buffers.length; i++) {
					if (buffers[i] === void 0) {
						continue;
					}
					if (buffers_to_read_back[i]) {
						queue.enqueueReadBuffer(buffers[i], true, 0, params[i].datum.byte_length, params[i].datum.data);
					}
					buffers[i].release();
				};
			};
		}();
	})();

	$CL.eachOperationGenerator = function(id, operator) {
		// if the wises are same
		var kernel1 = $CL.createKernel(
			"kernel_" + id + "_1", [
			"__kernel void kernel_" + id + "_1(__global float *a, __global float *b, uint iNumElements) ",
			"{                                                                           ",
			"    size_t i =  get_global_id(0);                                           ",
			"    if(i >= iNumElements) return;                                           ",
			"    a[i] = a[i] " + operator + " b[i];                                      ",
			"}                                                                           "].join('\r\n')
		);
		// different wises
		var kernel2 = $CL.createKernel(
			"kernel_" + id + "_2", [
			"__kernel void kernel_" + id + "_2(__global float *a, __global float *b, uint iNumElements, uint rows, uint cols) ",
			"{                                                                           ",
			"    size_t i =  get_global_id(0);                                           ",
			"    if(i >= iNumElements) return;                                           ",
			"    a[i] = a[i] " + operator + " b[(i % cols) * rows + i / cols];           ",
			"}                                                                           "].join('\r\n')
		);
		
		// different wises (particularly for incommutable function)
		var kernel3 = $CL.createKernel(
			"kernel_" + id + "_3", [
			"__kernel void kernel_" + id + "_3(__global float *a, __global float *b, uint iNumElements, uint rows, uint cols) ",
			"{                                                                                             ",
			"    size_t i =  get_global_id(0);                                                             ",
			"    if(i >= iNumElements) return;                                                             ",
			"    a[(i % cols) * rows + i / cols] = a[(i % cols) * rows + i / cols] " + operator + " b[i];  ",
			"}                                                                                             "].join('\r\n')
		);
		
		// broadcast 1
		var kernel4 = $CL.createKernel(
			"kernel_" + id + "_4", [
			"__kernel void kernel_" + id + "_4(__global float *a, __global float *b, uint iNumElements, uint b_length) ",
			"{                                                                                             ",
			"    size_t i =  get_global_id(0);                                                             ",
			"    if(i >= iNumElements) return;                                                             ",
			"    a[i] = a[i] " + operator + " b[i % b_length];                                             ",
			"}                                                                                             "].join('\r\n')
		);
		
		// broadcast 2
		var kernel5 = $CL.createKernel(
				"kernel_" + id + "_5", [
				"__kernel void kernel_" + id + "_5(__global float *a, __global float *b, uint iNumElements, uint b_skip) ",
				"{                                                                                             ",
				"    size_t i =  get_global_id(0);                                                             ",
				"    if(i >= iNumElements) return;                                                             ",
				"    a[i] = a[i] " + operator + " b[i / b_skip];                                               ",
				"}                                                                                             "].join('\r\n')
			);
		
		return function(mat1, mat2) {
			if (!(
				(mat1.rows === mat2.rows && mat1.cols === mat2.cols) ||
				(mat1.rows === mat2.rows && mat2.cols === 1) ||
				(mat1.cols === mat2.cols && mat2.rows === 1) ) ) {
					throw new Error('shape does not match');
			}
			var kernel_to_use = null;
			if (mat1.rows === mat2.rows && mat1.cols === mat2.cols) {
				if (mat1.row_wise === mat2.row_wise) {
					kernel_to_use = kernel1;
				} else if (mat1.row_wise === true) {
					kernel_to_use = kernel2;
				} else {
					kernel_to_use = kernel3;
				}
			} else if ((mat1.row_wise && mat2.rows === 1) || (!mat1.row_wise && mat2.cols === 1)) {
				// broadcast 1
				kernel_to_use = kernel4;
			} else {
				// broadcast 2
				kernel_to_use = kernel5;
			}
			
			var params = [
				{ access : WebCL.MEM_READ_WRITE, datum : mat1 },
				{ access : WebCL.MEM_READ_ONLY, datum : mat2 },
				{ datum : mat1.length, type : WebCL.type.UINT }
			];
			if (kernel_to_use === kernel2 || kernel_to_use === kernel3) {
				params.push({ datum : mat1.rows, type : WebCL.type.UINT });
				params.push({ datum : mat1.cols, type : WebCL.type.UINT });
			} else if (kernel_to_use === kernel4) {
				params.push({ datum : mat2.length, type : WebCL.type.UINT });
			} else if (kernel_to_use === kernel5) {
				params.push({ datum : mat1.length / mat2.length, type : WebCL.type.UINT });
			}
			
			$CL.executeKernel(kernel_to_use, params, mat1.length);
		};
	};
	
	$CL.add = $CL.eachOperationGenerator('add', '+');
	
	$CL.sub = $CL.eachOperationGenerator('sub', '-');
	
	$CL.mulEach = $CL.eachOperationGenerator('mulEach', '*');
	
	$CL.mul = function() {
		var kernel1 = $CL.createKernel(
				"kernel_mul_1",
				"__kernel void kernel_mul_1(__global float *a, __global float *b, __global float *c, uint iNumElements, uint rows, uint cols, uint width) " +
				"{                                                                           " +
				"    size_t i =  get_global_id(0);                                           " +
				"    if(i >= iNumElements) return;                                           " +
				"    uint row = i / cols;                                                    " +
				"    uint col = i % cols;                                                    " +
				"    float sum = 0.0;                                                        " +
				"    for (uint j = 0; j < width; j++) {                                      " +
				"        sum += a[row * width + j] * b[j * cols + col];                      " +
				"    }                                                                       " +
				"    c[i] = sum;                                                             " +
				"}                                                                           "
			);
		var kernel2 = $CL.createKernel(
				"kernel_mul_2", [
				"__kernel void kernel_mul_2(__global float *a, __global float *b, __global float *c, uint iNumElements, uint rows, uint cols, uint width) ",
				"{                                                                           ",
				"    size_t i =  get_global_id(0);                                           ",
				"    if(i >= iNumElements) return;                                           ",
				"    uint row = i / cols;                                                    ",
				"    uint col = i % cols;                                                    ",
				"    float sum = 0.0;                                                        ",
				"    for (uint j = 0; j < width; j++) {                                      ",
				"        sum += a[row * width + j] * b[j + col * width];                     ",
				"    }                                                                       ",
				"    c[i] = sum;                                                             ",
				"}                                                                           "].join('\r\n')
			);
		var kernel3 = $CL.createKernel(
				"kernel_mul_3", [
				"__kernel void kernel_mul_3(__global float *a, __global float *b, __global float *c, uint iNumElements, uint rows, uint cols, uint width) ",
				"{                                                                           ",
				"    size_t i =  get_global_id(0);                                           ",
				"    if(i >= iNumElements) return;                                           ",
				"    uint row = i / cols;                                                    ",
				"    uint col = i % cols;                                                    ",
				"    float sum = 0.0;                                                        ",
				"    for (uint j = 0; j < width; j++) {                                      ",
				"        sum += a[row + j * rows] * b[j * cols + col];                       ",
				"    }                                                                       ",
				"    c[i] = sum;                                                             ",
				"}                                                                           "].join('\r\n')
			);
		var kernel4 = $CL.createKernel(
				"kernel_mul_4", [
				"__kernel void kernel_mul_4(__global float *a, __global float *b, __global float *c, uint iNumElements, uint rows, uint cols, uint width) ",
				"{                                                                           ",
				"    size_t i =  get_global_id(0);                                           ",
				"    if(i >= iNumElements) return;                                           ",
				"    uint row = i / cols;                                                    ",
				"    uint col = i % cols;                                                    ",
				"    float sum = 0.0;                                                        ",
				"    for (uint j = 0; j < width; j++) {                                      ",
				"        sum += a[row + j * rows] * b[j + col * width];                      ",
				"    }                                                                       ",
				"    c[i] = sum;                                                             ",
				"}                                                                           "].join('\r\n')
			);
		return function(mat1, mat2) {
			if (mat1.cols !== mat2.rows) {
				throw new Error('shape does not match');
			}
			if (mat1.row_wise === true && mat2.row_wise === true) {
				kernel_to_use = kernel1;
			} else if (mat1.row_wise === true && mat2.row_wise === false) {
				kernel_to_use = kernel2;
			} else if (mat1.row_wise === false && mat2.row_wise === true) {
				kernel_to_use = kernel3;
			} else {
				kernel_to_use = kernel4;
			}
			
			var newM = new $M(mat1.rows, mat2.cols);
			$CL.executeKernel(
				kernel_to_use,
				[
					{ access : WebCL.MEM_READ_ONLY, datum : mat1 },
					{ access : WebCL.MEM_READ_ONLY, datum : mat2 },
					{ access : WebCL.MEM_WRITE_ONLY, datum : newM },
					{ datum : newM.length, type : WebCL.type.UINT},
					{ datum : newM.rows, type : WebCL.type.UINT},
					{ datum : newM.cols, type : WebCL.type.UINT},
					{ datum : mat1.cols, type : WebCL.type.UINT }
				],
				newM.length
			);
			return newM;
		};
	}();
	
	$CL.times = function() {
		var kernel_to_use = $CL.createKernel(
				"kernel_times",
				"__kernel void kernel_times(__global float *a, float b, uint iNumElements)   " +
				"{                                                                           " +
				"    size_t i =  get_global_id(0);                                           " +
				"    if(i >= iNumElements) return;                                           " +
				"    a[i] *= b;                                                              " +
				"}                                                                           "
			);
		return function(mat1, times) {
			$CL.executeKernel(
				kernel_to_use,
				[
					{ access : WebCL.MEM_READ_WRITE, datum : mat1 },
					{ datum : times, type : WebCL.type.FLOAT}, 
					{ datum : mat1.length, type : WebCL.type.UINT }
				],
				mat1.length
			);
			return mat1;
		};
	}();
	
	// alter large matrix calculation
	(function() {
		$P.largeAdd = function(mat) { $CL.add(this, mat); return this; };
		$M.largeAdd = function(mat1, mat2) { return mat1.clone().largeAdd(mat2); };
		$P.largeSub = function(mat) { $CL.sub(this, mat); return this; };
		$M.largeSub = function(mat1, mat2) { return mat1.clone().largeSub(mat2); };
		$P.largeMulEach = function(mat) { $CL.mulEach(this, mat); return this; };
		$M.largeMulEach = function(mat1, mat2) { return mat1.clone().largeMulEach(mat2); };
		$P.largeMul = function(mat) { return $CL.mul(this, mat); };
		$M.largeMul = $CL.mul;
		$P.largeTimes = function(times) { return $CL.times(this, times); };
	})();
})();