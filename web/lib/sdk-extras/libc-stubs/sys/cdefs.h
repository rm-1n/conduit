#ifndef _SYS_CDEFS_H_STUB
#define _SYS_CDEFS_H_STUB

#ifdef __cplusplus
# define __BEGIN_DECLS extern "C" {
# define __END_DECLS }
#else
# define __BEGIN_DECLS
# define __END_DECLS
#endif

#define __THROW
#define __nonnull(...)
#define __wur

#define __always_inline   __attribute__((__always_inline__))
#define __noinline        __attribute__((__noinline__))
#define __aligned(x)      __attribute__((__aligned__(x)))
#define __packed          __attribute__((__packed__))
#define __unused          __attribute__((__unused__))
#define __used            __attribute__((__used__))
#define __weak            __attribute__((__weak__))
#define __printflike(a,b) __attribute__((__format__(__printf__, a, b)))
#define __attribute_pure__    __attribute__((__pure__))
#define __attribute_const__   __attribute__((__const__))
#define __attribute_used__    __attribute__((__used__))
#define __attribute_malloc__  __attribute__((__malloc__))

#define __CONCAT1(a, b) a ## b
#define __CONCAT(a, b)  __CONCAT1(a, b)
#define __STRING(a)     #a

#endif
