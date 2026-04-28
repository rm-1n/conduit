#ifndef _ASSERT_H_STUB
#define _ASSERT_H_STUB
#ifdef NDEBUG
#define assert(x) ((void)0)
#else
#define assert(x) ((void)(x))
#endif
#define static_assert _Static_assert
#endif
