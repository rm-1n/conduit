# firmware/tests/Makefile — host-side unit tests for the firmware app.
#
# Compiled with the host's clang/gcc (NOT arm-none-eabi). The Pico SDK
# is not on the include path; identity.c is compiled with the
# CONDUIT_IDENTITY_HOSTTEST guard so the bootrom-dependent IO half is
# excluded. Only the pure parser + sha256 are exercised.
#
# Targets:
#   make           build all tests
#   make test      build + run; prints per-case PASS/FAIL, exits with
#                  the failure count so CI can gate on `make test`
#   make clean     wipe ./build
#
# Usage from the repo root:
#   make -C firmware/tests test

CC      ?= cc
CFLAGS  ?= -O2 -g -std=c11 -Wall -Wextra -Werror -Wno-unused-parameter
APP     := ../app
BUILD   := build

TESTS := $(BUILD)/test_identity $(BUILD)/test_ota_ring

.PHONY: all test clean
all: $(TESTS)

$(BUILD):
	@mkdir -p $@

$(BUILD)/test_identity: test_identity.c $(APP)/identity.c $(APP)/sha256.c $(APP)/identity.h $(APP)/sha256.h | $(BUILD)
	$(CC) $(CFLAGS) -DCONDUIT_IDENTITY_HOSTTEST -I$(APP) \
	    test_identity.c $(APP)/identity.c $(APP)/sha256.c \
	    -o $@

$(BUILD)/test_ota_ring: test_ota_ring.c $(APP)/ota_ring.c $(APP)/ota_ring.h | $(BUILD)
	$(CC) $(CFLAGS) -DOTA_RING_HOSTTEST -I$(APP) \
	    test_ota_ring.c $(APP)/ota_ring.c \
	    -o $@

test: $(TESTS)
	@for t in $(TESTS); do \
	    echo "=== $$t ==="; \
	    $$t || exit $$?; \
	done

clean:
	rm -rf $(BUILD)
